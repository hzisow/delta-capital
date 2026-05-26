#!/bin/bash
# Sync the runtime sidecar.py from the Desktop git repo to ~/.delta-capital/.
# Run this after editing sidecar.py if you want changes to take effect.
# Also re-installs requirements.txt in case dependencies changed.
#
# After running, the launchd agent will pick up the new sidecar on its next
# crash-restart. To restart immediately:
#   launchctl unload ~/Library/LaunchAgents/com.henryzisow.delta-capital.plist
#   launchctl load   ~/Library/LaunchAgents/com.henryzisow.delta-capital.plist

set -e

DESKTOP="$HOME/Desktop/delta-capital"
RUNTIME="$HOME/.delta-capital"

echo "Syncing sidecar.py..."
cp "$DESKTOP/sidecar.py" "$RUNTIME/sidecar.py"

echo "Checking requirements..."
"$RUNTIME/sidecar-venv/bin/pip" install --quiet -r "$DESKTOP/requirements.txt"

echo "Done. Restart with:"
echo "  launchctl kickstart -k gui/\$UID/com.henryzisow.delta-capital"
