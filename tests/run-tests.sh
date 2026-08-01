#!/bin/bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
TEST_SANDBOX="$(mktemp -d)"
trap 'rm -rf "$TEST_SANDBOX"' EXIT

PYTHON_BIN="$(command -v python3)"
JQ_BIN="$(command -v jq)"
CLEAN_PATH="$(dirname "$PYTHON_BIN"):$(dirname "$JQ_BIN"):/usr/bin:/bin"
mkdir -p "$TEST_SANDBOX/home" "$TEST_SANDBOX/tmp"

bash -n "$ROOT/state.sh"
env -i \
  HOME="$TEST_SANDBOX/home" \
  PATH="$CLEAN_PATH" \
  TMPDIR="$TEST_SANDBOX/tmp" \
  PYTHONPYCACHEPREFIX="$TEST_SANDBOX/pycache" \
  "$PYTHON_BIN" -m py_compile "$ROOT/check.py" "$ROOT/validate_schema.py" "$DIR/test_suite.py"
exec env -i \
  HOME="$TEST_SANDBOX/home" \
  PATH="$CLEAN_PATH" \
  TMPDIR="$TEST_SANDBOX/tmp" \
  PYTHONPYCACHEPREFIX="$TEST_SANDBOX/pycache" \
  "$PYTHON_BIN" "$DIR/test_suite.py"
