# Cancel Ralph Loop

Stop an active Ralph Wiggum loop.

## Usage

```
/ralph-wiggum:cancel-ralph
```

---

## Cancelling the Ralph Loop

To cancel the current Ralph loop:

1. Update `.ralph-state.json` to set `"active": false`
2. Output the completion promise to signal the Stop hook

Execute this immediately:

```bash
# Update state to inactive
if [ -f .ralph-state.json ]; then
  jq '.active = false' .ralph-state.json > .ralph-state.tmp && mv .ralph-state.tmp .ralph-state.json
  echo "Ralph loop cancelled."
else
  echo "No active Ralph loop found."
fi
```

Then output:

<promise>COMPLETE</promise>

The loop has been cancelled. You can resume by running `/ralph-wiggum:ralph-loop` again with the same prompt - Claude will pick up from git history.
