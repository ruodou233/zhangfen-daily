#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

TEST_DIR = Path(__file__).resolve().parent
ROOT = TEST_DIR.parent
STATE = ROOT / "state.sh"
CHECK = ROOT / "check.py"
VALIDATOR = ROOT / "validate_schema.py"
FIXTURES = TEST_DIR / "fixtures"

passed = 0
failed = 0


def ok(name: str) -> None:
    global passed
    passed += 1
    print(f"  ok - {name}")


def bad(name: str, detail: str = "") -> None:
    global failed
    failed += 1
    print(f"  FAIL - {name}{': ' + detail if detail else ''}", file=sys.stderr)


def check(name: str, condition: bool, detail: str = "") -> None:
    ok(name) if condition else bad(name, detail)


def run(
    command: list[str | Path], *, env: dict[str, str] | None = None, expect: int | None = 0,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        [str(item) for item in command], env=env, text=True,
        capture_output=True, timeout=20,
    )
    if expect is not None and result.returncode != expect:
        raise AssertionError(
            f"command {command} rc={result.returncode}\nstdout={result.stdout}\nstderr={result.stderr}"
        )
    return result


def parse_run_id(stdout: str) -> str:
    for line in stdout.splitlines():
        if line.startswith("run_id="):
            return line.split("=", 1)[1]
    raise AssertionError(f"no run_id in {stdout!r}")


def state_env(root: Path) -> dict[str, str]:
    env = os.environ.copy()
    env["GR_STATE_DIR"] = str(root / "state")
    env["GR_DATA_DIR"] = str(root / "data")
    return env


def state_tests(root: Path) -> None:
    print("# state.sh")
    env = state_env(root)
    state_dir = Path(env["GR_STATE_DIR"])
    state_file = state_dir / "growth-radar.json"

    rid = parse_run_id(run([STATE, "start"], env=env).stdout)
    run([STATE, "success", rid, "https://example.com/reports/daily", "3"], env=env)
    value = json.loads(state_file.read_text())
    check("通用 HTTPS artifact 正常收尾", value["status"] == "success" and value["case_count"] == 3)

    rid = parse_run_id(run([STATE, "start"], env=env).stdout)
    local_artifact = str(root / "daily report.md")
    run([STATE, "success", rid, local_artifact, "0"], env=env)
    value = json.loads(state_file.read_text())
    check("本地绝对路径 artifact 可用", value["artifact_url"] == local_artifact)

    rid = parse_run_id(run([STATE, "start"], env=env).stdout)
    empty = run([STATE, "success", rid, "", "1"], env=env, expect=None)
    relative = run([STATE, "success", rid, "reports/daily.md", "1"], env=env, expect=None)
    check("空 artifact 拒绝且不写", empty.returncode != 0 and json.loads(state_file.read_text())["status"] == "running")
    check("相对 artifact 路径拒绝", relative.returncode != 0)

    mismatch = run([STATE, "failed", "wrong-id", "x"], env=env, expect=None)
    check("run_id 不匹配拒绝且不写", mismatch.returncode != 0 and json.loads(state_file.read_text())["status"] == "running")
    double = run([STATE, "start"], env=env, expect=None)
    check("双 start 拒绝", double.returncode != 0)
    run([STATE, "abandon", rid], env=env)

    stale_time = (datetime.now(timezone.utc) - timedelta(hours=4)).strftime("%Y-%m-%dT%H:%M:%SZ")
    stale = {
        "run_id": "stale-1", "report_date": "2020-01-01", "started_at": stale_time,
        "finished_at": None, "phase": "collect", "status": "running",
        "completeness": "partial", "artifact_url": None, "artifact_token": None,
        "intents": {"artifact-create": None, "notify-send": None}, "error": None,
        "case_count": None,
    }
    state_file.write_text(json.dumps(stale), encoding="utf-8")
    takeover = run([STATE, "start"], env=env)
    new_rid = parse_run_id(takeover.stdout)
    check("3h 陈旧 run 自动接管", new_rid != "stale-1" and "auto-abandoned" in takeover.stdout)

    run([STATE, "phase", new_rid, "collect", "running"], env=env)
    run([STATE, "completeness", new_rid, "complete"], env=env)
    run([STATE, "artifact-token", new_rid, "Artifact_123"], env=env)
    run([STATE, "intent", new_rid, "artifact-create", "pending"], env=env)
    run([STATE, "intent", new_rid, "artifact-create", "done"], env=env)
    value = json.loads(state_file.read_text())
    check("phase/completeness/artifact-token/intent 更新", (
        value["phase"] == "collect" and value["completeness"] == "complete"
        and value["artifact_token"] == "Artifact_123"
        and value["intents"]["artifact-create"] == "done"
    ))

    processes = [
        subprocess.Popen(
            [str(STATE), "completeness", new_rid, value], env=env,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        for value in ("complete", "partial", "rank_only", "failed") * 3
    ]
    for process in processes:
        process.wait(timeout=10)
    try:
        value = json.loads(state_file.read_text())
        concurrent_ok = value["completeness"] in {"complete", "partial", "rank_only", "failed"}
    except Exception:
        concurrent_ok = False
    check("并发写仍为完整 JSON", concurrent_ok and all(p.returncode == 0 for p in processes))

    before = state_file.read_bytes()
    lock = state_dir / ".growth-radar-state.lock"
    lock.mkdir()
    (lock / "pid").write_text(str(os.getpid()), encoding="utf-8")
    blocked = subprocess.Popen(
        [str(STATE), "completeness", new_rid, "partial"], env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    time.sleep(0.2)
    blocked.send_signal(signal.SIGTERM)
    blocked.wait(timeout=5)
    shutil.rmtree(lock)
    check("中断不产生半写文件", state_file.read_bytes() == before and bool(json.loads(state_file.read_text())))
    run([STATE, "failed", new_rid, "test cleanup"], env=env)

    symlink_dir = root / "symlink-entry"
    symlink_dir.mkdir()
    symlink = symlink_dir / "growth-radar-state"
    symlink.symlink_to(STATE)
    symlink_root = root / "symlink-case"
    symlink_env = state_env(symlink_root)
    symlink_rid = parse_run_id(run([symlink, "start"], env=symlink_env).stdout)
    run([symlink, "failed", symlink_rid, "test cleanup"], env=symlink_env)
    check("symlink 入口可运行", (Path(symlink_env["GR_STATE_DIR"]) / "growth-radar.json").exists())


def make_notify_hook(root: Path) -> tuple[Path, Path]:
    output = root / "notifications.log"
    script = root / "notify-hook"
    script.write_text("#!/bin/bash\ncat >> \"$HOOK_OUTPUT\"\n", encoding="utf-8")
    script.chmod(0o755)
    return script, output


def check_env(root: Path, day: str) -> dict[str, str]:
    env = os.environ.copy()
    env.update({
        "GR_STATE_DIR": str(root),
        "GR_LOG_DIR": str(root / "logs"),
    })
    env.pop("GR_NOTIFY_CMD", None)
    return env


def line_count(path: Path) -> int:
    return len(path.read_text().splitlines()) if path.exists() else 0


def check_tests(root: Path) -> None:
    print("# check.py")
    hook, _ = make_notify_hook(root)

    case = root / "check-hook"
    case.mkdir()
    output = case / "hook.log"
    env = check_env(case, "2026-07-18")
    env.update({"GR_NOTIFY_CMD": str(hook), "HOOK_OUTPUT": str(output)})
    run([sys.executable, CHECK, "--now", "2026-07-18T11:00:00+08:00"], env=env)
    check("通知钩子从 stdin 收到告警", line_count(output) == 1 and "缺席" in output.read_text())

    case = root / "check-stdout"
    case.mkdir()
    env = check_env(case, "2026-07-18")
    result = run([sys.executable, CHECK, "--now", "2026-07-18T11:00:00+08:00"], env=env)
    check("未配置钩子时输出 stdout", "缺席" in result.stdout)

    case = root / "check-running"
    case.mkdir()
    output = case / "hook.log"
    state = {
        "report_date": "2026-07-18", "status": "running",
        "started_at": "2026-07-18T02:30:00Z", "completeness": "partial",
    }
    (case / "growth-radar.json").write_text(json.dumps(state), encoding="utf-8")
    env = check_env(case, "2026-07-18")
    env.update({"GR_NOTIFY_CMD": str(hook), "HOOK_OUTPUT": str(output)})
    run([sys.executable, CHECK, "--now", "2026-07-18T11:00:00+08:00"], env=env)
    check("running<2h 只提示不告警", (
        line_count(output) == 1 and "仍在运行" in output.read_text()
        and not (case / "growth-radar-check-state.json").exists()
    ))

    case = root / "check-dedupe"
    case.mkdir()
    output = case / "hook.log"
    env = check_env(case, "2026-07-18")
    env.update({"GR_NOTIFY_CMD": str(hook), "HOOK_OUTPUT": str(output)})
    command = [sys.executable, CHECK, "--now", "2026-07-18T11:00:00+08:00"]
    run(command, env=env)
    run(command, env=env)
    check("同日告警去重", line_count(output) == 1)
    run([sys.executable, CHECK, "--now", "2026-07-19T11:00:00+08:00"], env=env)
    check("跨日去重重置", line_count(output) == 2)

    case = root / "check-dry-run"
    case.mkdir()
    output = case / "hook.log"
    env = check_env(case, "2026-07-18")
    env.update({"GR_NOTIFY_CMD": str(hook), "HOOK_OUTPUT": str(output)})
    run([sys.executable, CHECK, "--dry-run", "--now", "2026-07-18T11:00:00+08:00"], env=env)
    check("dry-run 不调用通知钩子", not output.exists())


def schema_tests(root: Path) -> None:
    print("# validate_schema.py")
    cases = (
        ("valid", "valid", 0),
        ("v2-inferred", "valid", 0),
        ("invalid", "invalid", 1),
        ("legacy-explicit", "legacy-explicit", 0),
        ("v2-missing-field", "valid", 1),
    )
    for obs_kind, manifest_kind, expected in cases:
        obs = FIXTURES / f"observations-{obs_kind}.jsonl"
        manifest = FIXTURES / f"manifest-{manifest_kind}.jsonl"
        result = run(
            [sys.executable, VALIDATOR, "--observations", obs, "--manifest", manifest],
            expect=None,
        )
        check(f"schema observations={obs_kind}", result.returncode == expected, result.stderr)
        if obs_kind == "legacy-explicit":
            check("显式 legacy 仅告警", "WARN" in result.stderr and "ERROR" not in result.stderr)
        if obs_kind == "v2-missing-field":
            check("v2 缺新字段为 ERROR", "ERROR" in result.stderr and "v2 行缺新字段" in result.stderr)
        if obs_kind == "v2-inferred":
            check("无版本但新字段齐全按 v2 校验", "ERROR" not in result.stderr)


def workflow_contract_tests(root: Path) -> None:
    print("# 幂等崩溃窗口 + completeness")
    case_root = root / "workflow"
    env = state_env(case_root)
    state_file = Path(env["GR_STATE_DIR"]) / "growth-radar.json"
    rid = parse_run_id(run([STATE, "start"], env=env).stdout)

    run([STATE, "intent", rid, "artifact-create", "pending"], env=env)
    remote_artifacts = {"Growth Radar 2026-07-18": "RemoteArtifact123"}
    create_calls = 0
    value = json.loads(state_file.read_text())
    if value["intents"]["artifact-create"] == "pending" and value["artifact_token"] is None:
        token = remote_artifacts.get("Growth Radar 2026-07-18")
        if token is None:
            create_calls += 1
            token = "NewArtifact"
        run([STATE, "artifact-token", rid, token], env=env)
        run([STATE, "intent", rid, "artifact-create", "done"], env=env)
    check("产物创建后 token 未落盘时先对账", (
        create_calls == 0 and json.loads(state_file.read_text())["artifact_token"] == "RemoteArtifact123"
    ))

    run([STATE, "intent", rid, "notify-send", "pending"], env=env)
    history = {"2026-07-18:RemoteArtifact123"}
    send_calls = 0
    if "2026-07-18:RemoteArtifact123" not in history:
        send_calls += 1
    run([STATE, "intent", rid, "notify-send", "done"], env=env)
    check("通知已发但标记未落盘时先查后发", send_calls == 0)

    def classify(
        successes: int, analysis_complete: bool, model_verified: bool,
        main_failed: bool, all_others_failed: bool,
    ) -> str:
        if main_failed and all_others_failed:
            return "failed"
        if not analysis_complete or not model_verified:
            return "rank_only"
        if successes >= 4:
            return "complete"
        return "partial"

    cases = [
        ((5, True, True, False, False), "complete"),
        ((3, True, True, False, False), "partial"),
        ((5, True, False, False, False), "rank_only"),
        ((0, False, False, True, True), "failed"),
    ]
    check("completeness 判定表四态", all(classify(*args) == expected for args, expected in cases))
    run([STATE, "failed", rid, "test cleanup"], env=env)


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="growth-radar-tests.") as temp:
        root = Path(temp)
        try:
            state_tests(root)
            check_tests(root)
            schema_tests(root)
            workflow_contract_tests(root)
        except Exception as exc:  # noqa: BLE001
            bad("测试套件未捕获异常", repr(exc))
    print(f"# result: {passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
