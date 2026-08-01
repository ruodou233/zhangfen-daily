#!/usr/bin/env python3
"""检查 growth-radar 当日运行是否成功，并通过可插拔钩子发出提示。"""
from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

STATE_DIR = Path(os.environ.get("GR_STATE_DIR", "./state"))
STATE = STATE_DIR / "growth-radar.json"
CHECK_STATE = STATE_DIR / "growth-radar-check-state.json"
LOG = Path(os.environ.get("GR_LOG_DIR", "./logs")) / "check.log"
NOTIFY_CMD = os.environ.get("GR_NOTIFY_CMD", "").strip()
EARLIEST_CHECK = (11, 0)


def parse_now(value: str | None) -> datetime:
    if value:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo is None else parsed.astimezone()
    return datetime.now().astimezone()


def log(message: str) -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as handle:
        handle.write(f"{datetime.now().isoformat(timespec='seconds')} {message}\n")


def read_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    except BaseException:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise


def notify(text: str, *, dry_run: bool) -> bool:
    if dry_run:
        log(f"dry-run notification: {text}")
        return True
    if not NOTIFY_CMD:
        print(text)
        return True
    try:
        subprocess.run(
            shlex.split(NOTIFY_CMD), input=f"{text}\n", check=True,
            capture_output=True, text=True, timeout=60,
        )
        return True
    except Exception as exc:  # noqa: BLE001 - 任何钩子失败都应留下日志
        log(f"notification hook FAILED: {exc}")
        return False


def running_age_seconds(state: dict[str, Any], now: datetime) -> float | None:
    try:
        started = datetime.fromisoformat(str(state["started_at"]).replace("Z", "+00:00"))
        if started.tzinfo is None:
            started = started.replace(tzinfo=timezone.utc)
        return (now.astimezone(timezone.utc) - started.astimezone(timezone.utc)).total_seconds()
    except (KeyError, TypeError, ValueError):
        return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="只记录将发出的提示")
    parser.add_argument("--now", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)

    now = parse_now(args.now)
    if (now.hour, now.minute) < EARLIEST_CHECK:
        log(f"early catch-up run ({now.strftime('%H:%M')}) — skip")
        return 0
    today = now.date().isoformat()

    state: dict[str, Any] | None = None
    problem: str | None = None
    try:
        loaded = read_json(STATE)
        if not isinstance(loaded, dict):
            raise ValueError("root is not an object")
        state = loaded
    except FileNotFoundError:
        problem = "状态文件不存在（任务可能从未运行）"
    except Exception as exc:  # noqa: BLE001
        problem = f"状态文件不可读: {exc}"

    if state is not None:
        if state.get("report_date") != today:
            problem = (
                f"今天没有运行记录（最近: report_date={state.get('report_date')} "
                f"status={state.get('status')}）"
            )
        elif state.get("status") == "success":
            log(f"ok report_date={today} case_count={state.get('case_count')}")
            return 0
        elif state.get("status") == "running":
            age = running_age_seconds(state, now)
            if age is not None and 0 <= age < 2 * 3600:
                minutes = int(age / 60)
                info = f"ℹ️ Growth Radar 仍在运行（已 {minutes} 分钟），未超过 2 小时。"
                log(f"running {minutes}min — info only")
                if not notify(info, dry_run=args.dry_run):
                    log("running info notification FAILED")
                    return 1
                return 0
            problem = f"今天 run 超时或 started_at 不可解析: status=running age={age}"
        else:
            problem = (
                f"今天运行未成功: status={state.get('status')} "
                f"completeness={state.get('completeness')} error={state.get('error')}"
            )

    assert problem is not None
    try:
        marker = read_json(CHECK_STATE)
    except (FileNotFoundError, ValueError, TypeError, json.JSONDecodeError):
        marker = {}
    if isinstance(marker, dict) and marker.get("last_alert_date") == today:
        log(f"alert deduplicated report_date={today}: {problem}")
        return 0

    message = f"⚠️ Growth Radar 今日缺席或失败：{problem}。请补跑或排查。"
    log(f"alert: {problem}")
    if not notify(message, dry_run=args.dry_run):
        log("alert notification FAILED; marker not written")
        return 1
    atomic_json(CHECK_STATE, {
        "last_alert_date": today,
        "sent_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    })
    log("alert emitted and dedupe marker committed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
