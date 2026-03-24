#!/bin/bash
# Bot control script
# Usage: ./ctl <paper|live> <go|pause>

MODE="$1"
ACTION="$2"

if [ -z "$MODE" ] || [ -z "$ACTION" ]; then
  echo "Usage: ./ctl <paper|live> <go|pause>"
  echo "  ./ctl paper go     — activate paper bot"
  echo "  ./ctl paper pause  — pause paper bot"
  echo "  ./ctl live go      — activate live bot"
  echo "  ./ctl live pause   — pause live bot"
  exit 1
fi

case "$MODE" in
  paper) FILE="paper_control.json" ;;
  live)  FILE="live_control.json" ;;
  *)
    echo "Error: mode must be 'paper' or 'live'"
    exit 1
    ;;
esac

case "$ACTION" in
  go)    PAUSED="false" ;;
  pause) PAUSED="true" ;;
  *)
    echo "Error: action must be 'go' or 'pause'"
    exit 1
    ;;
esac

echo "{\"paused\":$PAUSED}" > "$FILE"
echo "$MODE bot: $([ "$PAUSED" = "true" ] && echo "PAUSED" || echo "ACTIVE")"
