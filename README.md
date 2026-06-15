# pi-goal

Persistent autonomous goals for pi. Define what "done" means, the agent works until it's done.

## Installation

```bash
pi install pi-goal
```

Or from the repo:

```bash
pi install git:github.com/nijaru/pi-goal
```

## Usage

```
/goal all tests pass and lint is clean
```

The agent creates a goal, works autonomously, and repeats until complete, blocked, or budget-limited. The loop continues across turns — no manual prompting needed.

### Commands

| Command | Description |
|---------|-------------|
| `/goal <objective>` | Create a new goal |
| `/goal status` | Show current goal |
| `/goal pause` | Pause the loop |
| `/goal resume` | Resume a paused goal |
| `/goal clear` | Clear the current goal |

### Tools

| Tool | Description |
|------|-------------|
| `create_goal` | Set objective + budget (agent or user) |
| `get_goal` | Read current goal state |
| `update_goal` | Mark complete or blocked |
| `log_iteration` | Record attempt, git commit/revert |
| `log_idea` | Log promising approach to ideas backlog |
| `evaluate_goal` | Optional adversarial second opinion |

### Goal Lifecycle

```
active → complete       (goal met, verified via completion audit)
active → blocked        (same blocker for 3+ consecutive turns)
active → budget_limited (budget exhausted)
active → paused         (/goal pause)
paused → active         (/goal resume)
```

## How It Works

**Completion audit** — The continuation prompt forces the agent to verify every requirement against actual state before marking complete. This is adversarial-by-design: the agent must prove completion, not just claim it.

**Blocked audit** — After 3 consecutive turns of the same blocker, the goal is marked blocked. Different blockers reset the counter. Resuming a blocked goal starts a fresh audit.

**Git-native** — Each iteration commits on `kept` or reverts on `reverted`. The worktree is the source of truth.

**Ideas backlog** — Promising-but-untried approaches are logged to prevent random walk.

**Iteration journal** — Every logged attempt is recorded in `.pi/goal/<id>/journal.md` with hypothesis, result, cost, and commit hash.

## Hooks

Run commands before/after each iteration:

```js
create_goal({
  objective: "all tests pass",
  budget: 5,
  beforeEach: "git stash && git checkout baseline",
  afterEach: "npm test",
});
```

## Budget

Budget is in USD, required. No unbounded loops.

## File Structure

```
.pi/goal/<goal-id>/
├── state.json     # goal state (budget, status, lifecycle)
├── journal.md     # iteration log
└── ideas.md       # promising-but-untried approaches
```

## Influences

- **Codex CLI** — completion audit, blocked audit, agent-set goals
- **Claude Code** — external evaluator pattern
- **Karpathy autoresearch** — git-native keep/revert, metric loop

## License

MIT
