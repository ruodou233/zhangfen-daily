#!/bin/bash
# growth-radar 运行状态适配器。
set -euo pipefail

die() { echo "state.sh error: $*" >&2; exit 1; }
today_local() { date +%Y-%m-%d; }
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

STATE_DIR="${GR_STATE_DIR:-./state}"
DATA_DIR="${GR_DATA_DIR:-./data}"
STATE_FILE="$STATE_DIR/growth-radar.json"
STATE_LOCK="$STATE_DIR/.growth-radar-state.lock"
mkdir -p "$STATE_DIR" "$DATA_DIR"

release_lock() { rm -rf "$STATE_LOCK" 2>/dev/null || true; }

lock_mtime() {
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null
}

acquire_lock() {
  local i oldpid lock_epoch age quarantine
  for i in $(seq 1 50); do
    if mkdir "$STATE_LOCK" 2>/dev/null; then
      printf '%s\n' "$$" > "$STATE_LOCK/pid"
      trap release_lock EXIT
      return 0
    fi
    oldpid="$(cat "$STATE_LOCK/pid" 2>/dev/null || true)"
    if [[ -z "$oldpid" ]]; then
      lock_epoch="$(lock_mtime "$STATE_LOCK" || true)"
      if [[ -z "$lock_epoch" ]]; then
        quarantine="$STATE_LOCK.unreadable.$$"
        mv "$STATE_LOCK" "$quarantine" 2>/dev/null && rm -rf "$quarantine"
        continue
      fi
      age=$(( $(date +%s) - lock_epoch ))
      if (( age > 10 )); then
        quarantine="$STATE_LOCK.stale.$$"
        mv "$STATE_LOCK" "$quarantine" 2>/dev/null && rm -rf "$quarantine"
      fi
      sleep 0.1
      continue
    fi
    if ! kill -0 "$oldpid" 2>/dev/null; then
      quarantine="$STATE_LOCK.stale.$$"
      if mv "$STATE_LOCK" "$quarantine" 2>/dev/null; then
        oldpid="$(cat "$quarantine/pid" 2>/dev/null || true)"
        if [[ -n "$oldpid" ]] && kill -0 "$oldpid" 2>/dev/null; then
          mv "$quarantine" "$STATE_LOCK" 2>/dev/null || rm -rf "$quarantine"
        else
          rm -rf "$quarantine"
        fi
        continue
      fi
    fi
    sleep 0.1
  done
  die "状态锁 5s 未获得，拒绝无锁写入: $STATE_LOCK"
}

state_schema_ok() {
  jq -e '
    type == "object" and
    (["run_id","report_date","started_at","finished_at","phase","status","completeness",
      "artifact_url","artifact_token","intents","error","case_count"] - keys | length == 0) and
    (.run_id|type == "string") and (.report_date|type == "string") and
    (.started_at|type == "string") and (.phase|type == "string") and
    (.status == "running" or .status == "success" or .status == "failed" or .status == "abandoned") and
    (.completeness == "complete" or .completeness == "partial" or
     .completeness == "rank_only" or .completeness == "failed") and
    (.intents|type == "object") and
    (["artifact-create","notify-send"] - (.intents|keys) | length == 0)
  ' "$STATE_FILE" >/dev/null 2>&1
}

atomic_filter() {
  local filter="$1" tmp
  shift
  tmp="$(mktemp "$STATE_DIR/.growth-radar.XXXXXX")"
  if ! jq "$@" "$filter" "$STATE_FILE" > "$tmp"; then
    rm -f "$tmp"
    die "状态更新失败，原文件未改动"
  fi
  mv "$tmp" "$STATE_FILE"
}

write_new_state() {
  local run_id="$1" report_date="$2" started_at="$3" tmp
  tmp="$(mktemp "$STATE_DIR/.growth-radar.XXXXXX")"
  jq -n --arg run_id "$run_id" --arg report_date "$report_date" --arg started_at "$started_at" '
    {run_id:$run_id, report_date:$report_date, started_at:$started_at,
     finished_at:null, phase:"start", status:"running", completeness:"partial",
     artifact_url:null, artifact_token:null,
     intents:{"artifact-create":null,"notify-send":null}, error:null, case_count:null}
  ' > "$tmp"
  mv "$tmp" "$STATE_FILE"
}

iso_epoch() {
  python3 - "$1" <<'PY'
from datetime import datetime
import sys
try:
    value = sys.argv[1]
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    print(int(datetime.fromisoformat(value).timestamp()))
except Exception:
    raise SystemExit(1)
PY
}

load_running() {
  local claimed="$1"
  [[ -f "$STATE_FILE" ]] || die "状态文件不存在，无 run 可更新"
  state_schema_ok || die "状态文件 schema 不合格，拒绝写入"
  RUN_ID="$(jq -r '.run_id' "$STATE_FILE")"
  CURRENT_STATUS="$(jq -r '.status' "$STATE_FILE")"
  [[ "$claimed" == "$RUN_ID" ]] || die "run_id 不匹配（当前: ${RUN_ID}，收到: ${claimed}）"
  [[ "$CURRENT_STATUS" == "running" ]] || die "当前 run 已是终态 ${CURRENT_STATUS}，拒绝更新/重复收尾"
}

validate_run_id() { [[ "${1:-}" =~ ^[A-Za-z0-9._-]{1,100}$ ]] || die "run_id 格式非法"; }

mode="${1:-}"
case "$mode" in
  start|success|failed|abandon|phase|completeness|artifact-token|intent) acquire_lock ;;
esac

case "$mode" in
  start)
    [[ $# -eq 1 ]] || die "start 不接受额外参数"
    new_id="$(date +%Y%m%d-%H%M%S)-$$"
    if [[ -f "$STATE_FILE" ]]; then
      state_schema_ok || die "状态文件存在但 schema 不合格，人工检查后再 start"
      cur_status="$(jq -r '.status' "$STATE_FILE")"
      cur_id="$(jq -r '.run_id' "$STATE_FILE")"
      if [[ "$cur_status" == "running" ]]; then
        cur_started="$(jq -r '.started_at' "$STATE_FILE")"
        started_epoch="$(iso_epoch "$cur_started" 2>/dev/null)" \
          || die "running run 的 started_at 无法解析，拒绝误接管: $cur_started"
        now_epoch="$(date +%s)"
        age=$(( now_epoch - started_epoch ))
        if (( age < 3 * 3600 )); then
          die "已有 running run（run_id=${cur_id}，${age}s），未超 3h 拒绝覆盖"
        fi
        atomic_filter '.status="abandoned" | .phase="stale-takeover" | .completeness="failed" |
          .finished_at=$now | .error=("automatically abandoned: stale running exceeded 3h; takeover="+$takeover)' \
          --arg now "$(now_iso)" --arg takeover "$new_id"
        echo "state: auto-abandoned stale run (run_id=$cur_id age=${age}s takeover=$new_id)"
      fi
    fi
    write_new_state "$new_id" "$(today_local)" "$(now_iso)"
    echo "run_id=$new_id"
    echo "state: running (report_date=$(today_local))"
    ;;
  success)
    [[ $# -eq 4 ]] || die "用法: success <run_id> <artifact_url> <case_count>"
    rid="$2"; artifact="$3"; count="$4"
    validate_run_id "$rid"
    [[ "$count" =~ ^[0-9]{1,5}$ ]] || die "case_count 必须是 0-99999 整数"
    [[ -n "$artifact" ]] || die "artifact_url 不能为空"
    if [[ ! "$artifact" =~ ^https?://[^[:space:]]+$ && "$artifact" != /* ]]; then
      die "artifact_url 必须是 http(s) URL 或本地绝对路径"
    fi
    load_running "$rid"
    atomic_filter '.status="success" | .phase="published" | .finished_at=$now |
      .artifact_url=$artifact | .case_count=($count|tonumber) | .error=null' \
      --arg now "$(now_iso)" --arg artifact "$artifact" --arg count "$count"
    echo "state: success (run_id=$rid cases=$count)"
    ;;
  failed)
    [[ $# -eq 3 ]] || die "用法: failed <run_id> <error>"
    rid="$2"; err="$3"; validate_run_id "$rid"; [[ -n "$err" ]] || die "error 不能为空"
    err="${err:0:500}"
    load_running "$rid"
    atomic_filter '.status="failed" | .phase="failed" | .completeness="failed" |
      .finished_at=$now | .error=$error' --arg now "$(now_iso)" --arg error "$err"
    echo "state: failed (run_id=$rid)"
    ;;
  abandon)
    [[ $# -eq 2 ]] || die "用法: abandon <run_id>"
    rid="$2"; validate_run_id "$rid"; load_running "$rid"
    atomic_filter '.status="abandoned" | .phase="abandoned" | .completeness="failed" |
      .finished_at=$now | .error="manually abandoned"' --arg now "$(now_iso)"
    echo "state: abandoned (run_id=$rid)"
    ;;
  phase)
    [[ $# -eq 4 ]] || die "用法: phase <run_id> <phase> <status>"
    rid="$2"; phase="$3"; next_status="$4"; validate_run_id "$rid"
    [[ "$phase" =~ ^[a-z][a-z0-9_-]{0,63}$ ]] || die "phase 只允许小写字母/数字/_/-"
    [[ "$next_status" == "running" ]] || die "phase status 只允许 running；终态请用收尾命令"
    load_running "$rid"
    atomic_filter '.phase=$phase | .status=$status' --arg phase "$phase" --arg status "$next_status"
    echo "state: phase=$phase status=$next_status (run_id=$rid)"
    ;;
  completeness)
    [[ $# -eq 3 ]] || die "用法: completeness <run_id> <complete|partial|rank_only|failed>"
    rid="$2"; value="$3"; validate_run_id "$rid"
    [[ "$value" =~ ^(complete|partial|rank_only|failed)$ ]] || die "completeness 枚举非法: $value"
    load_running "$rid"
    atomic_filter '.completeness=$value' --arg value "$value"
    echo "state: completeness=$value (run_id=$rid)"
    ;;
  artifact-token)
    [[ $# -eq 3 ]] || die "用法: artifact-token <run_id> <token>"
    rid="$2"; token="$3"; validate_run_id "$rid"
    [[ "$token" =~ ^[A-Za-z0-9._-]{4,200}$ ]] || die "artifact token 格式非法"
    load_running "$rid"
    atomic_filter '.artifact_token=$token' --arg token "$token"
    echo "state: artifact_token saved (run_id=$rid)"
    ;;
  intent)
    [[ $# -eq 4 ]] || die "用法: intent <run_id> <artifact-create|notify-send> <pending|done>"
    rid="$2"; action="$3"; value="$4"; validate_run_id "$rid"
    [[ "$action" =~ ^(artifact-create|notify-send)$ ]] || die "intent action 非法: $action"
    [[ "$value" =~ ^(pending|done)$ ]] || die "intent status 非法: $value"
    load_running "$rid"
    atomic_filter '.intents[$action]=$value' --arg action "$action" --arg value "$value"
    echo "state: intent $action=$value (run_id=$rid)"
    ;;
  *)
    die "用法: start | success <run_id> <artifact_url> <case_count> | failed <run_id> <error> | abandon <run_id> | phase <run_id> <phase> <status> | completeness <run_id> <value> | artifact-token <run_id> <token> | intent <run_id> <action> <pending|done>"
    ;;
esac
