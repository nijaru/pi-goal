# pi-goal

Persistent autonomous goals for pi. Define what "done" means, and the agent works until it's done.

Goal mode, autoresearch, and "just keep prompting" are the same loop. pi-goal formalizes it with persistent state, git-native checkpoints, and a separate evaluator.

## Installation

```bash
pi install git:github.com/nijaru/pi-goal
```

Or copy manually:

```bash
# Global
cp -r . ~/.pi/agent/extensions/pi-goal

# Project-local
cp -r . .pi/extensions/pi-goal
```

**Requires:** pi with extension support, a git repository.

## Quick Start

```
> /goal all tests pass and lint is clean

✅ Goal created
Objective: all tests pass
Budget: $5.00
```

A status widget shows progress:

```
─── Goal ───────────────────────────────
  ◉ active  iter: 3  cost: $0.12 / $5.00
  all tests pass and lint is clean
```

Each iteration, the agent makes a change, runs your hooks, and logs the result. If the change helps, it commits. If not, it reverts.

## User Commands

Type these in the pi TUI:

| Command | Description |
|---------|-------------|
| `/goal <objective>` | Create a new goal |
| `/goal status` | Show current goal |
| `/goal pause` | Pause the loop |
| `/goal resume` | Resume a paused goal |
| `/goal clear` | Clear the current goal |

## Agent Tools

The agent calls these automatically — you don't need to use them directly:

| Tool | Description |
|------|-------------|
| `create_goal` | Set objective + budget |
| `get_goal` | Read current goal state |
| `update_goal` | Mark complete or blocked |
| `log_iteration` | Record attempt, git commit/revert |
| `log_idea` | Log approach to ideas backlog |
| `evaluate_goal` | Self or adversarial evaluation |

## Safety

- **No unbounded loops.** Budget is required. The loop stops when it's exhausted.
- **Auto-continue limit.** 50 automatic continuations maximum.
- **Completion audit.** A separate evaluator confirms the goal is met — the agent can't grade its own homework. Use `adversarial` mode for subjective goals, `self` for objective evidence.
- **Blocked audit.** After 3 consecutive turns of the same blocker, the goal is marked blocked.

## How It Works

The agent keeps working until the goal is met or the budget runs out. Each attempt is checkpointed with git — you can inspect or roll back any iteration. A separate evaluator checks the result before allowing completion.

See [DESIGN.md](DESIGN.md) for the full API design, convergence criteria, and prior art.

## Goal Lifecycle

```
active → complete       (goal met, verified via completion audit)
active → blocked        (same blocker for 3+ consecutive turns)
active → budget_limited (budget exhausted)
active → paused         (/goal pause)
paused → active         (/goal resume)
```

## File Structure

```
.pi/goal/<goal-id>/
├── state.json     # goal state (budget, status, lifecycle)
├── journal.md     # iteration log
└── ideas.md       # promising-but-untried approaches
```

## Influences

- **Codex CLI** inspired the completion audit, blocked audit, and agent-set goals
- **Claude Code** demonstrated the external evaluator pattern
- **Karpathy autoresearch** established git-native keep/revert and the metric loop

## License

MIT
