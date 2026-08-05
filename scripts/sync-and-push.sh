#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${X_REPLIES_REPO:-/root/x-replies-search-sync}"
LOCK_FILE="${X_REPLIES_LOCK:-/run/lock/x-replies-search.lock}"

exec 9>"$LOCK_FILE"
flock -n 9 || exit 0

cd "$REPO_ROOT"
git pull --ff-only origin main

export TWS_PROXY="${TWS_PROXY:-http://127.0.0.1:7890}"
export TWS_DB="${TWS_DB:-/root/accounts.db}"
export PYTHONPATH="${PYTHONPATH:-/root/.local/share/uv/tools/twscrape/lib/python3.12/site-packages}"

args=("$@")
if [[ ${#args[@]} -eq 0 && $(date -u +%H) == "03" ]]; then
  args=(--full)
fi

python3 scripts/update-replies.py "${args[@]}"

if git diff --quiet -- data/replies.json; then
  echo "No snapshot changes to push"
  exit 0
fi

git add data/replies.json
git commit -m "chore: hourly X reply snapshot $(date -u +%Y-%m-%dT%H:%MZ)"
git push origin main
