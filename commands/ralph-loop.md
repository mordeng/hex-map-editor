# Ralph Loop Command

Start an autonomous iterative development loop.

## Arguments

- `prompt` (required): The task description for Claude to work on
- `--max-iterations N`: Maximum number of iterations (default: 50)
- `--completion-promise TEXT`: The exact phrase that signals task completion (default: `<promise>COMPLETE</promise>`)

## Usage

```
/ralph-wiggum:ralph-loop "Implement a REST API with full test coverage" --max-iterations 20 --completion-promise "<promise>COMPLETE</promise>"
```

---

You are now entering a **Ralph Wiggum Loop** - an autonomous, iterative development cycle.

## Your Task

$ARGUMENTS

## How This Works

1. You will work on the task described above
2. When you attempt to exit, a Stop hook will intercept and re-feed this prompt
3. Each iteration, you can see your previous work via git history and modified files
4. The loop continues until you output the **completion promise** or reach max iterations

## Completion Criteria

When your task is **fully complete** (all tests passing, all requirements met), output:

```
<promise>COMPLETE</promise>
```

This signals the Stop hook to allow exit and end the loop.

## Guidelines

1. **Read first**: Check git log and git diff to see what you did in previous iterations
2. **Run tests**: Always run tests to verify your work
3. **Iterate**: Don't aim for perfect on first try - let the loop refine the work
4. **Be explicit**: Document your progress in commit messages
5. **Clear completion**: Only output the completion promise when ALL criteria are met

## State Management

A state file at `.ralph-state.json` tracks:
- Current iteration count
- Max iterations allowed
- The completion promise to look for
- Whether the loop is active

---

**BEGIN ITERATION**

First, check the current state:
1. Read `.ralph-state.json` if it exists
2. Check `git log --oneline -10` for recent work
3. Check `git status` for uncommitted changes
4. Then proceed with the task

If this is the first iteration, create `.ralph-state.json` with:
```json
{
  "active": true,
  "iteration": 1,
  "maxIterations": $MAX_ITERATIONS,
  "completionPromise": "$COMPLETION_PROMISE",
  "startedAt": "$TIMESTAMP"
}
```

Good luck! Remember: Ralph never stops trying.
