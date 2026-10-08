#!/bin/bash
# Refreshes docs/data.json (Curzon) from a machine with a residential IP and
# pushes it to master. GitHub Actions can't do this: Cloudflare blocks its
# datacenter IPs outright, whatever the browser fingerprint.
#
# Works in its own clone (~/.curzon-refresh/repo) that only ever tracks master,
# so it never touches whatever you have checked out in your working copy.
# Installed on a schedule by scripts/install-launchd.sh.
#
#   DRY_RUN=1  scrape and commit locally but don't push
#   WORK_DIR   where the clone and log live (default ~/.curzon-refresh)
set -euo pipefail

REPO_URL="${REPO_URL:-git@github.com:mijewe/whatsoncurzon.git}"
WORK_DIR="${WORK_DIR:-$HOME/.curzon-refresh}"
REPO_DIR="$WORK_DIR/repo"
LOG_FILE="$WORK_DIR/refresh.log"

mkdir -p "$WORK_DIR"
exec >>"$LOG_FILE" 2>&1
echo "=== $(date '+%Y-%m-%d %H:%M:%S') ==="

# launchd/cron start with a minimal PATH. Find node the usual places, including
# the newest nvm-managed version since nvm only loads in interactive shells.
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  NVM_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1 || true)"
  [ -n "$NVM_BIN" ] && PATH="$NVM_BIN:$PATH"
fi

notify_failure() {
  echo "FAILED (exit $?) — see $LOG_FILE"
  if command -v osascript >/dev/null 2>&1; then
    osascript -e 'display notification "Curzon showtimes refresh failed — see ~/.curzon-refresh/refresh.log" with title "curzon-but-better"' || true
  fi
}
trap notify_failure ERR

# Don't let two runs overlap (e.g. a slow run plus the next scheduled one).
LOCK_DIR="$WORK_DIR/.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "Another run is in progress, skipping."
  exit 0
fi
trap 'rmdir "$LOCK_DIR"' EXIT

if [ ! -d "$REPO_DIR/.git" ]; then
  git clone --depth 1 --branch master "$REPO_URL" "$REPO_DIR"
fi
cd "$REPO_DIR"

# Always start from exactly what's on master — the previous data.json is the
# cache for RT scores, firstSeen and leaving-soon tracking.
git fetch --depth 1 origin master
git reset --hard origin/master

npm ci --no-audit --no-fund
npx playwright install chromium

npm run refresh

git add docs/data.json
if git diff --staged --quiet; then
  echo "No changes."
  exit 0
fi
git commit -m "Refresh showtimes data"

if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "DRY_RUN: committed locally, not pushing."
  exit 0
fi

# GitHub Actions pushes The Light's data to the same branch, so a push can race
# it. We only ever touch docs/data.json and it only touches the Light's, so on a
# rejected push just take the new master and re-apply our file on top.
cp docs/data.json "$WORK_DIR/data.json.new"
for attempt in 1 2 3; do
  if git push origin HEAD:master; then
    echo "Pushed."
    exit 0
  fi
  echo "Push rejected (attempt $attempt), re-applying on latest master..."
  git fetch --depth 1 origin master
  git reset --hard origin/master
  cp "$WORK_DIR/data.json.new" docs/data.json
  git add docs/data.json
  git commit -m "Refresh showtimes data"
done
exit 1
