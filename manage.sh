#!/bin/bash

# Good Morning Auto-Scheduler Management Script
# Project ID: f7a13ae9-344f-4fb9-9379-3d25ecb4d2f1

SCHEDULER_DIR="/agent/apps/good-morning-scheduler"
PID_FILE="$SCHEDULER_DIR/scheduler.pid"
LOG_FILE="$SCHEDULER_DIR/scheduler.log"
STATUS_FILE="$SCHEDULER_DIR/last-run.json"
INDEX_JS="$SCHEDULER_DIR/index.js"

# Color output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Helper function to get PID if running
get_pid() {
  if [ -f "$PID_FILE" ]; then
    cat "$PID_FILE"
  fi
}

# Helper function to check if process is actually running
is_running() {
  local pid=$(get_pid)
  if [ -n "$pid" ]; then
    if ps -p "$pid" > /dev/null 2>&1; then
      return 0
    else
      # PID file exists but process is not running - clean up stale PID file
      rm -f "$PID_FILE"
      return 1
    fi
  fi
  return 1
}

# Start command
start() {
  if is_running; then
    local pid=$(get_pid)
    echo -e "${YELLOW}Scheduler is already running (PID: $pid)${NC}"
    return 1
  fi

  echo "Starting Good Morning Auto-Scheduler..."

  # Check if index.js exists
  if [ ! -f "$INDEX_JS" ]; then
    echo -e "${RED}Error: Scheduler script not found at $INDEX_JS${NC}"
    return 1
  fi

  # Start the process in the background
  cd "$SCHEDULER_DIR"
  nohup node "$INDEX_JS" >> "$LOG_FILE" 2>&1 &
  local pid=$!

  # Save PID to file
  echo "$pid" > "$PID_FILE"

  # Give it a moment to start
  sleep 1

  # Verify it's running
  if is_running; then
    echo -e "${GREEN}✓ Scheduler started successfully (PID: $pid)${NC}"
    echo "  Log file: $LOG_FILE"
    echo "  PID file: $PID_FILE"
    return 0
  else
    echo -e "${RED}✗ Failed to start scheduler${NC}"
    echo "  Check logs: tail -f $LOG_FILE"
    rm -f "$PID_FILE"
    return 1
  fi
}

# Stop command
stop() {
  if ! is_running; then
    echo -e "${YELLOW}Scheduler is not running${NC}"
    # Clean up stale PID file just in case
    rm -f "$PID_FILE"
    return 1
  fi

  local pid=$(get_pid)
  echo "Stopping Good Morning Auto-Scheduler (PID: $pid)..."

  # Send SIGTERM for graceful shutdown
  kill -TERM "$pid" 2>/dev/null

  # Wait for process to stop (max 5 seconds)
  local count=0
  while ps -p "$pid" > /dev/null 2>&1 && [ $count -lt 10 ]; do
    sleep 0.5
    count=$((count + 1))

    # Check if it's a zombie process
    if ps -p "$pid" -o stat= 2>/dev/null | grep -q 'Z'; then
      echo "Process became zombie, considering it stopped"
      break
    fi
  done

  # Force kill if still running and not a zombie
  if ps -p "$pid" > /dev/null 2>&1; then
    if ! ps -p "$pid" -o stat= 2>/dev/null | grep -q 'Z'; then
      echo "Process did not stop gracefully, forcing..."
      kill -9 "$pid" 2>/dev/null
      sleep 0.5
    fi
  fi

  # Clean up PID file
  rm -f "$PID_FILE"

  # Consider zombie processes as stopped (they'll be cleaned up by parent)
  if ! ps -p "$pid" > /dev/null 2>&1 || ps -p "$pid" -o stat= 2>/dev/null | grep -q 'Z'; then
    echo -e "${GREEN}✓ Scheduler stopped successfully${NC}"
    return 0
  else
    echo -e "${RED}✗ Failed to stop scheduler${NC}"
    return 1
  fi
}

# Status command
status() {
  echo "========================================================================"
  echo "Good Morning Auto-Scheduler - Status"
  echo "========================================================================"

  if is_running; then
    local pid=$(get_pid)
    echo -e "Status: ${GREEN}RUNNING${NC}"
    echo "PID: $pid"

    # Show process info
    echo ""
    echo "Process Info:"
    ps -p "$pid" -o pid,etime,cmd 2>/dev/null | tail -n +2

  else
    echo -e "Status: ${RED}STOPPED${NC}"
  fi

  echo ""
  echo "Files:"
  echo "  Config: $INDEX_JS"
  echo "  PID file: $PID_FILE"
  echo "  Log file: $LOG_FILE"
  echo "  Status file: $STATUS_FILE"

  # Show last run information if available
  if [ -f "$STATUS_FILE" ]; then
    echo ""
    echo "Last Run Info:"
    echo "------------------------------------------------------------------------"
    cat "$STATUS_FILE" 2>/dev/null | grep -E '"(timestamp|success|error|responseStatus)"' | sed 's/^/  /'
  fi

  # Show last few log lines
  if [ -f "$LOG_FILE" ]; then
    echo ""
    echo "Recent Logs (last 10 lines):"
    echo "------------------------------------------------------------------------"
    tail -n 10 "$LOG_FILE" 2>/dev/null | sed 's/^/  /'
  fi

  echo "========================================================================"
}

# Main command dispatcher
case "$1" in
  start)
    start
    ;;
  stop)
    stop
    ;;
  restart)
    stop
    sleep 1
    start
    ;;
  status)
    status
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status}"
    echo ""
    echo "Commands:"
    echo "  start   - Start the Good Morning Auto-Scheduler"
    echo "  stop    - Stop the Good Morning Auto-Scheduler"
    echo "  restart - Restart the Good Morning Auto-Scheduler"
    echo "  status  - Check status and show last run info"
    exit 1
    ;;
esac

exit $?
