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

Each iteration, the agent makes a change, runs your hooks, and logs the result. If the change helps, it commits. If not, it reverts. The loop continues until the goal is met, blocked, or the budget runs out.

## User Commands

| Command | Description |
|---------|-------------|
| `/goal <objective>` | Create a new goal |
| `/goal status` | Show current goal |
| `/goal pause` | Pause the loop |
| `/goal resume` | Resume a paused goal |
| `/goal clear` | Clear the current goal |

## Agent Tools

The agent calls these automatically while pursuing a goal:

| Tool | Description |
|------|-------------|
| `create_goal` | Set objective + budget |
| `get_goal` | Read current goal state |
| `update_goal` | Mark complete or blocked |
| `log_iteration` | Record attempt, git commit/revert |
| `log_idea` | Log approach to ideas backlog |
| `evaluate_goal` | Self or adversarial evaluation |

The agent can create goals for itself or for subagents via `create_goal`.

## Configuration

```js
create_goal({
  objective: "all tests pass",
  budget: 5,
  beforeEach: "git stash && git checkout baseline",
  afterEach: "npm test",
});
```

- `budget` required, in USD. The loop stops when cost exceeds this.
- `objective` required, should be concrete and verifiable.
- `beforeEach` / `afterEach` optional shell commands run before/after each iteration.

## Safety

- **No unbounded loops.** Budget is required. The loop stops when it's exhausted.
- **Auto-continue limit.** 50 automatic continuations maximum as a guardrail.
- **Completion audit.** A separate evaluator (subagent with fresh context) must confirm the goal is met before the agent can mark it complete. The agent can't grade its own homework.
- **Evaluation modes.** Adversarial for subjective goals like "refactor for clarity." Self mode for objective evidence (tests pass, build succeeds).
- **Blocked audit.** After 3 consecutive turns of the same blocker, the goal is marked blocked.

## How It Works

**Ideas backlog.** Promising-but-untried approaches are logged and surfaced in continuation prompts to prevent random walk.

**Iteration journal.** Every attempt is recorded in `.pi/goal/<id>/journal.md` with hypothesis, result, cost, and commit hash.

**Compaction-aware.** Goal state survives context compaction.

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
- **Claude Code** proved the external evaluator pattern
- **Karpathy autoresearch** established git-native keep/revert and the metric loop

## License

MIT
