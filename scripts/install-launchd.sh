#!/bin/bash
# Installs (or removes) a launchd agent that runs scripts/local-refresh.sh once
# a day while the Mac is on.
#
#   scripts/install-launchd.sh             install / update
#   scripts/install-launchd.sh uninstall   remove
#
# launchd runs a StartCalendarInterval job that was missed while the Mac slept
# once on wake; runs missed while it was powered off are skipped.
set -euo pipefail

LABEL="com.mijewe.curzon-refresh"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
BIN_DIR="$HOME/.curzon-refresh/bin"
DOMAIN="gui/$(id -u)"

# Once a day (0=Sun..6=Sat; a day the Mac is off is simply skipped).
WEEKDAYS="0 1 2 3 4 5 6"
TIMES="11:30"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true

if [ "${1:-}" = "uninstall" ]; then
  rm -f "$PLIST"
  echo "Removed $LABEL (logs and the clone in ~/.curzon-refresh are left in place)."
  exit 0
fi

# Copy the script somewhere stable so the schedule doesn't depend on which
# branch is checked out in your working copy. Re-run this to pick up changes.
mkdir -p "$BIN_DIR" "$(dirname "$PLIST")"
cp "$(dirname "$0")/local-refresh.sh" "$BIN_DIR/local-refresh.sh"
chmod +x "$BIN_DIR/local-refresh.sh"

{
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$BIN_DIR/local-refresh.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
EOF
  for day in $WEEKDAYS; do
    for time in $TIMES; do
      printf '    <dict><key>Weekday</key><integer>%d</integer><key>Hour</key><integer>%d</integer><key>Minute</key><integer>%d</integer></dict>\n' \
        "$day" "$((10#${time%%:*}))" "$((10#${time##*:}))"
    done
  done
  cat <<EOF
  </array>
</dict>
</plist>
EOF
} > "$PLIST"

plutil -lint "$PLIST"
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "Installed $LABEL: daily at ${TIMES// /, }."
echo "Run it now:  launchctl kickstart $DOMAIN/$LABEL"
echo "Logs:        ~/.curzon-refresh/refresh.log"
