#!/bin/bash

# Ralph Wiggum Stop Hook
# Intercepts Claude's exit attempts and forces continuation if:
# 1. A ralph loop is active
# 2. The completion promise hasn't been output
# 3. We haven't exceeded max iterations

set -e

# Read JSON input from Claude Code via stdin
INPUT=$(cat)

# Extract values from JSON
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // "false"')

# State file location
STATE_FILE=".ralph-state.json"

# Prevent infinite loops - if we're already in a retry, allow stop
if [ "$STOP_HOOK_ACTIVE" = "true" ]; then
  exit 0
fi

# Check if ralph loop is active
if [ ! -f "$STATE_FILE" ]; then
  # No state file, no active loop
  exit 0
fi

# Read state
ACTIVE=$(jq -r '.active // false' "$STATE_FILE")
ITERATION=$(jq -r '.iteration // 0' "$STATE_FILE")
MAX_ITERATIONS=$(jq -r '.maxIterations // 50' "$STATE_FILE")
COMPLETION_PROMISE=$(jq -r '.completionPromise // "<promise>COMPLETE</promise>"' "$STATE_FILE")

# If loop is not active, allow stop
if [ "$ACTIVE" != "true" ]; then
  exit 0
fi

# Check if completion promise was output in the transcript
if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  if grep -q "$COMPLETION_PROMISE" "$TRANSCRIPT_PATH"; then
    # Completion promise found - deactivate loop and allow stop
    jq '.active = false' "$STATE_FILE" > "${STATE_FILE}.tmp" && mv "${STATE_FILE}.tmp" "$STATE_FILE"
    echo "Ralph loop completed successfully after $ITERATION iteration(s)." >&2
    exit 0
  fi
fi

# Check if we've exceeded max iterations
if [ "$ITERATION" -ge "$MAX_ITERATIONS" ]; then
  # Max iterations reached - deactivate loop and allow stop
  jq '.active = false' "$STATE_FILE" > "${STATE_FILE}.tmp" && mv "${STATE_FILE}.tmp" "$STATE_FILE"
  echo "Ralph loop reached maximum iterations ($MAX_ITERATIONS). Stopping." >&2
  exit 0
fi

# Increment iteration counter
NEW_ITERATION=$((ITERATION + 1))
jq ".iteration = $NEW_ITERATION" "$STATE_FILE" > "${STATE_FILE}.tmp" && mv "${STATE_FILE}.tmp" "$STATE_FILE"

# Block the stop and continue the loop
cat <<EOF
{
  "decision": "block",
  "reason": "Ralph loop iteration $NEW_ITERATION of $MAX_ITERATIONS. Task not yet complete - no completion promise detected. Continue working on the task. Check git log and git status to see your previous work, then proceed. Output '$COMPLETION_PROMISE' when all requirements are met."
}
EOF

exit 2
