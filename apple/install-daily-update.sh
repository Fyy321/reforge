#!/bin/bash
# macOS 每日榜单更新安装脚本：注册 launchd 代理，每天 04:30 跑一次。
# 用法: bash install-daily-update.sh [--schedule 4:30] [--out-dir ~/Library/Application Support/Ranks]
set -euo pipefail

LABEL="com.yourorg.ranks-daily"
OUT_DIR="${HOME}/Library/Application Support/Ranks"
SCHEDULE_HOUR=4
SCHEDULE_MIN=30

while (($# > 0)); do
  case "$1" in
    --schedule) IFS=: read -r SCHEDULE_HOUR SCHEDULE_MIN <<<"$2"; shift 2 ;;
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    *) echo "unknown: $1"; exit 1 ;;
  esac
done

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "未找到 node：请先安装 Node.js (https://nodejs.org)"; exit 1
fi
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
UPDATE_JS="$PROJECT_DIR/scripts/daily-update.js"
LOG_FILE="$OUT_DIR/daily-update.log"

mkdir -p "$OUT_DIR"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$UPDATE_JS</string>
        <string>--out-dir</string>
        <string>$OUT_DIR</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key><integer>$SCHEDULE_HOUR</integer>
        <key>Minute</key><integer>$SCHEDULE_MIN</integer>
    </dict>
    <key>StandardOutPath</key><string>$LOG_FILE</string>
    <key>StandardErrorPath</key><string>$LOG_FILE</string>
    <key>RunAtLoad</key><false/>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "已注册 launchd 每日任务：每天 $SCHEDULE_HOUR:$SCHEDULE_MIN"
echo "  plist:  $PLIST"
echo "  输出:   $OUT_DIR/ranks.json | ranks-apple.json | ranks.csv"
echo "  日志:   $LOG_FILE"
echo "  立即手动跑一次: node $UPDATE_JS --out-dir \"$OUT_DIR\""
echo "  卸载:   launchctl unload $PLIST && rm $PLIST"
