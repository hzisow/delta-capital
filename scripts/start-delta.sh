#!/bin/bash
# Boots the Delta Capital backend stack on this Mac:
#   1. Python sidecar (FastAPI + yfinance + curl_cffi)
#   2. Tailscale Funnel exposing :8001 to the internet
#
# Everything lives in ~/.delta-capital/ (NOT Desktop) so macOS doesn't
# sandbox-block the launchd-spawned bash from reading the venv/script.
# The git repo at ~/Desktop/delta-capital/ is used for editing; the
# runtime is a copy maintained by ~/.delta-capital/sync-from-desktop.sh.

set -e

WORK_DIR="$HOME/.delta-capital"
LOG="$WORK_DIR/start-delta.log"
SIDECAR_LOG="$WORK_DIR/sidecar.log"
mkdir -p "$WORK_DIR"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] start-delta booting" >> "$LOG"

# 1. Kill any stale sidecar on :8001
PIDS=$(lsof -ti :8001 2>/dev/null || true)
if [ -n "$PIDS" ]; then
  echo "[$(date '+%H:%M:%S')] killing stale sidecar PIDs: $PIDS" >> "$LOG"
  kill -9 $PIDS 2>/dev/null || true
  sleep 1
fi

# 2. Start the sidecar from the runtime copy at ~/.delta-capital/
cd "$WORK_DIR"
echo "[$(date '+%H:%M:%S')] starting sidecar" >> "$LOG"
source "$WORK_DIR/sidecar-venv/bin/activate"
nohup python3 "$WORK_DIR/sidecar.py" >> "$SIDECAR_LOG" 2>&1 &
SIDECAR_PID=$!
echo "[$(date '+%H:%M:%S')] sidecar PID $SIDECAR_PID" >> "$LOG"

# 3. Wait for sidecar to come up (max 60s)
for i in $(seq 1 60); do
  if curl -sf http://localhost:8001/health > /dev/null 2>&1; then
    echo "[$(date '+%H:%M:%S')] sidecar healthy after ${i}s" >> "$LOG"
    break
  fi
  sleep 1
done

if ! curl -sf http://localhost:8001/health > /dev/null 2>&1; then
  echo "[$(date '+%H:%M:%S')] ERROR: sidecar never became healthy" >> "$LOG"
  exit 1
fi

# 4. Start Tailscale Funnel (idempotent — repeated calls reuse the URL)
echo "[$(date '+%H:%M:%S')] starting Tailscale Funnel" >> "$LOG"
TAILSCALE_BIN="/usr/local/bin/tailscale"
[ ! -x "$TAILSCALE_BIN" ] && TAILSCALE_BIN="/opt/homebrew/bin/tailscale"
"$TAILSCALE_BIN" funnel --bg 8001 >> "$LOG" 2>&1 || true

echo "[$(date '+%H:%M:%S')] start-delta done" >> "$LOG"

# Block on the sidecar process. When it exits (crashed, killed, OOM, etc.),
# this script exits too — and launchd's KeepAlive immediately respawns us.
wait $SIDECAR_PID
EXIT_CODE=$?
echo "[$(date '+%H:%M:%S')] sidecar exited with $EXIT_CODE, launchd will restart" >> "$LOG"
exit $EXIT_CODE
