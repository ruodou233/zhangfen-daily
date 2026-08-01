#!/usr/bin/env python3
"""Validate growth-radar observations.jsonl and manifest.jsonl."""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

OBS_STATUSES = {"baselining", "active", "dormant", "invalid", "legacy"}
ATTRIBUTIONS = {"高可信", "中可信", "低可信", "无法归因"}
ANOMALIES = {"无异常迹象", "存疑", "确认异常", "未检查"}
OBS_NEW_FIELDS = {"count_exact", "count_resolution", "provider_as_of", "below_resolution"}
MANIFEST_NEW_FIELDS = {"attribution", "anomaly", "driver_works"}
CASE_ID_RE = re.compile(r"^[a-z0-9_-]+:[^:]+:[^:]+:[^:]+$")


class Findings:
    def __init__(self) -> None:
        self.errors = 0
        self.warnings = 0

    def error(self, path: Path, line: int, message: str) -> None:
        self.errors += 1
        print(f"ERROR {path}:{line}: {message}", file=sys.stderr)

    def warn(self, path: Path, line: int, message: str) -> None:
        self.warnings += 1
        print(f"WARN  {path}:{line}: {message}", file=sys.stderr)


def parse_iso(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def jsonl(path: Path, findings: Findings) -> Iterable[tuple[int, dict[str, Any]]]:
    try:
        handle = path.open(encoding="utf-8")
    except OSError as exc:
        findings.error(path, 0, f"无法打开: {exc}")
        return
    with handle:
        for number, raw in enumerate(handle, 1):
            if not raw.strip():
                continue
            try:
                value = json.loads(raw)
            except json.JSONDecodeError as exc:
                findings.error(path, number, f"JSON 无效: {exc.msg}")
                continue
            if not isinstance(value, dict):
                findings.error(path, number, "行必须是 JSON object")
                continue
            yield number, value


def valid_nonnegative_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def schema_mode(
    row: dict[str, Any], new_fields: set[str], path: Path, line: int, findings: Findings,
) -> str:
    version = row.get("schema_version")
    if "schema_version" in row:
        if not isinstance(version, int) or isinstance(version, bool):
            findings.error(path, line, "schema_version 必须是整数")
            return "invalid"
        if version < 2:
            findings.warn(path, line, f"legacy 豁免（schema_version={version}）")
            return "legacy"
    elif row.get("status") == "legacy":
        findings.warn(path, line, "legacy 豁免（status=legacy）")
        return "legacy"
    missing = sorted(new_fields - row.keys())
    if missing:
        findings.error(path, line, f"v2 行缺新字段: {','.join(missing)}")
        return "invalid"
    return "strict"


def validate_observations(path: Path, findings: Findings) -> None:
    strict_by_account: dict[str, list[tuple[int, dict[str, Any]]]] = defaultdict(list)
    sources: dict[str, set[str]] = defaultdict(set)
    for line, row in jsonl(path, findings):
        mode = schema_mode(row, OBS_NEW_FIELDS, path, line, findings)
        if mode == "legacy":
            missing_base = [key for key in ("account_key", "observed_at", "source", "status") if key not in row]
            if missing_base:
                findings.warn(path, line, f"legacy 行缺基础字段: {','.join(missing_base)}")
            status = row.get("status")
            if status is not None and status not in OBS_STATUSES:
                findings.warn(path, line, f"legacy status 未知: {status!r}")
            continue
        if mode == "invalid":
            continue

        required = ("account_key", "observed_at", "source", "status")
        missing_base = [key for key in required if key not in row]
        if missing_base:
            findings.error(path, line, f"缺必填字段: {','.join(missing_base)}")
            continue
        status = row["status"]
        if not isinstance(row["account_key"], str) or ":" not in row["account_key"]:
            findings.error(path, line, "account_key 必须是 platform:account")
        if parse_iso(row["observed_at"]) is None:
            findings.error(path, line, "observed_at 必须是 ISO-8601")
        if not isinstance(row["source"], str) or not row["source"].strip():
            findings.error(path, line, "source 必须是非空字符串")
        if status not in OBS_STATUSES - {"legacy"}:
            findings.error(path, line, f"status 枚举非法: {status!r}")

        exact = row["count_exact"]
        resolution = row["count_resolution"]
        below = row["below_resolution"]
        follower = row.get("follower_count")
        if not isinstance(exact, bool):
            findings.error(path, line, "count_exact 必须是 boolean")
        if not valid_nonnegative_int(resolution) or resolution < 1:
            findings.error(path, line, "count_resolution 必须是 >=1 的整数")
        if not isinstance(below, bool):
            findings.error(path, line, "below_resolution 必须是 boolean")
        if follower is not None and not valid_nonnegative_int(follower):
            findings.error(path, line, "follower_count 必须是非负整数或 null")
        if exact is True and resolution != 1:
            findings.error(path, line, "count_exact=true 时 count_resolution 必须为 1")
        if exact is True and below is True:
            findings.error(path, line, "精确计数不得标 below_resolution=true")
        if follower is None and below is not True:
            findings.error(path, line, "follower_count=null 时必须 below_resolution=true")
        if parse_iso(row["provider_as_of"]) is None:
            findings.error(path, line, "provider_as_of 必须是 ISO-8601")

        account = row["account_key"]
        sources[account].add(row["source"])
        strict_by_account[account].append((line, row))

    for account, values in sources.items():
        if len(values) > 1:
            findings.error(path, 0, f"{account} 主计数源不一致: {sorted(values)}")

    for account, entries in strict_by_account.items():
        entries.sort(key=lambda item: (
            parse_iso(item[1].get("observed_at")).timestamp()
            if parse_iso(item[1].get("observed_at")) is not None else float("-inf")
        ))
        previous: dict[str, Any] | None = None
        for line, row in entries:
            if row.get("delta") is not None:
                if previous is None:
                    findings.error(path, line, f"{account} 首个有效观测不得直接记 delta")
                else:
                    current_as_of = parse_iso(row.get("provider_as_of"))
                    previous_as_of = parse_iso(previous.get("provider_as_of"))
                    if current_as_of is None or previous_as_of is None or current_as_of <= previous_as_of:
                        findings.error(path, line, "provider_as_of 未推进，不得计 delta")
                    if not isinstance(row.get("delta"), int) or isinstance(row.get("delta"), bool):
                        findings.error(path, line, "delta 必须是整数或 null")
                    elif row.get("count_exact") and previous.get("count_exact"):
                        current_count = row.get("follower_count")
                        previous_count = previous.get("follower_count")
                        if valid_nonnegative_int(current_count) and valid_nonnegative_int(previous_count):
                            if row["delta"] != current_count - previous_count:
                                findings.error(path, line, "精确计数 delta 与前后 follower_count 不一致")
            previous = row


def validate_manifest(path: Path, findings: Findings) -> None:
    for line, row in jsonl(path, findings):
        mode = schema_mode(row, MANIFEST_NEW_FIELDS, path, line, findings)
        if mode != "strict":
            continue
        required = ("case_id", "platform", "account_id", "window_start", "window_end")
        missing = [key for key in required if key not in row]
        if missing:
            findings.error(path, line, f"缺必填字段: {','.join(missing)}")
            continue
        if not isinstance(row["case_id"], str) or CASE_ID_RE.fullmatch(row["case_id"]) is None:
            findings.error(path, line, "case_id 必须为 平台:账号:窗口start:窗口end（共四段）")
        if row["attribution"] not in ATTRIBUTIONS:
            findings.error(path, line, f"attribution 枚举非法: {row['attribution']!r}")
        if row["anomaly"] not in ANOMALIES:
            findings.error(path, line, f"anomaly 枚举非法: {row['anomaly']!r}")
        works = row["driver_works"]
        if not isinstance(works, list) or any(not isinstance(item, str) for item in works):
            findings.error(path, line, "driver_works 必须是字符串数组")


def main(argv: list[str] | None = None) -> int:
    default_root = Path(os.environ.get("GR_DATA_DIR", "./data"))
    parser = argparse.ArgumentParser()
    parser.add_argument("--observations", type=Path, default=default_root / "observations.jsonl")
    parser.add_argument("--manifest", type=Path, default=default_root / "manifest.jsonl")
    args = parser.parse_args(argv)
    findings = Findings()
    validate_observations(args.observations, findings)
    validate_manifest(args.manifest, findings)
    print(f"schema validation: {findings.errors} error(s), {findings.warnings} warning(s)")
    return 1 if findings.errors else 0


if __name__ == "__main__":
    sys.exit(main())
