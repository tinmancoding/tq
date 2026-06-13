#!/usr/bin/env bash
# Install the tq daemon as a launchd user agent (RunAtLoad + KeepAlive).
# The daemon runs via tsx directly from the repo (local-first, no build step).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="dev.tq.daemon"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$HOME/Library/Logs/tq"
NODE_BIN="$(command -v node)"
TSX="$REPO_ROOT/node_modules/.bin/tsx"
MAIN="$REPO_ROOT/packages/daemon/src/main.ts"

mkdir -p "$LOG_DIR" "$(dirname "$PLIST")"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${TSX}</string>
    <string>${MAIN}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG_DIR}/daemon.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/daemon.err</string>
  <key>WorkingDirectory</key><string>${REPO_ROOT}</string>
</dict>
</plist>
PLIST_EOF

echo "wrote $PLIST"
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "loaded ${LABEL}. logs: ${LOG_DIR}/daemon.log"
