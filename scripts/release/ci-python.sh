#!/usr/bin/env bash
# Python gate for the sidecar images and ops tooling (bridge/, indexer/,
# yubal/, ops/, e2e/): every tracked .py file must byte-compile, and when ruff
# is available the syntax/undefined-name rules (E9, F63, F7, F82) must pass.
# The full default ruff report is printed for information only.
set -euo pipefail
cd "$(dirname "$0")/../.."

mapfile -t files < <(git ls-files -- '*.py' ':!app/**' ':!**/node_modules/**')
[ "${#files[@]}" -gt 0 ] || { echo "ci-python: no python files"; exit 0; }
echo "py_compile on ${#files[@]} files"
# py_compile with the bytecode written to a temporary directory: no __pycache__
# left in the tree (python refuses /dev/null as cfile).
python3 - "${files[@]}" <<'EOF'
import os, py_compile, sys, tempfile
rc = 0
with tempfile.TemporaryDirectory() as tmp:
    for i, f in enumerate(sys.argv[1:]):
        try:
            py_compile.compile(f, cfile=os.path.join(tmp, f"{i}.pyc"), doraise=True)
        except py_compile.PyCompileError as e:
            print(e.msg, file=sys.stderr)
            rc = 1
sys.exit(rc)
EOF
echo "py_compile: ok"

if command -v ruff >/dev/null 2>&1; then
  ruff --version
  ruff check --isolated --select E9,F63,F7,F82 "${files[@]}"
  echo "ruff (syntax + undefined names): ok"
  echo "ruff default rule set (informational, not blocking):"
  ruff check --isolated --statistics "${files[@]}" || true
else
  echo "ruff not installed: syntax/undefined-name lint skipped"
fi
