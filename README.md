# pi-goal

Persistent autonomous goals for pi. Define what "done" means, and the agent works until it's done — across turns, with a completion audit and a budget cap.

## Installation

Install from git:

```bash
pi install git:github.com/nijaru/pi-goal
```

Or copy manually to your extensions directory:

```bash
# Global
cp -r . ~/.pi/agent/extensions/pi-goal

# Project-local
cp -r . .pi/extensions/pi-goal
```

## Requirements

- pi with extension support
- A git repository (pi-goal commits on keep and reverts on revert)

## Usage

Use `/goal` in pi's interactive editor:

```
/goal all tests pass and lint is clean
```

The agent creates a goal, then works autonomously until the goal is complete, blocked, or budget-limited. The loop continues across turns without manual prompting.

### Commands

These are slash commands for you:

| Command | Description |
|---------|-------------|
| `/goal <objective>` | Create a new goal |
| `/goal status` | Show current goal |
| `/goal pause` | Pause the loop |
| `/goal resume` | Resume a paused goal |
| `/goal clear` | Clear the current goal |

## Tools

These are tools the agent calls while pursuing a goal:

| Tool | Description |
|------|-------------|
| `create_goal` | Set objective + budget (agent or user) |
| `get_goal` | Read current goal state |
| `update_goal` | Mark complete or blocked |
| `log_iteration` | Record attempt, git commit/revert |
| `log_idea` | Log promising approach to ideas backlog |
| `evaluate_goal` | Optional evaluation (self or adversarial) |

The agent can create goals for itself or for subagents via `create_goal`, enabling meta-prompting.

## Configuration

Set when creating a goal:

```js
create_goal({
  objective: "all tests pass",
  budget: 5,
});
```

- `budget` — required, in USD. The loop stops when cost exceeds the budget.
- `objective` — required, should be concrete and verifiable.
- `beforeEach` — optional shell command run before each iteration.
- `afterEach` — optional shell command run after each iteration.

Example with hooks:

```js
create_goal({
  objective: "all tests pass",
  budget: 5,
  beforeEach: "git stash && git checkout baseline",
  afterEach: "npm test",
});
```

## Safety / Behavior

- **Autonomous loop:** Once active, the agent continues working across turns without further prompts.
- **Git side effects:** `log_iteration` with `status: "kept"` commits the working tree; `status: "reverted"` resets it.
- **Budget cap:** There are no unbounded loops. When the budget is exhausted, the goal becomes `budget_limited`.
- **Auto-continue limit:** The loop stops after 50 automatic continuations as a guardrail.
- **Widget:** A status widget shows the current objective, status, iteration count, and cost.

## Adversarial Evaluation

The `evaluate_goal` tool supports two modes:

- **Self mode** (default): The agent evaluates its own progress. Cheap and fast, but has self-preference bias. Works well for goals with concrete evidence (tests pass, build succeeds).
- **Adversarial mode**: Sends the goal and recent evidence to the agent with a skeptical prompt. The agent must argue against completion, citing specific evidence for each requirement. Better for subjective goals or when extra confidence is needed.

Use adversarial mode for goals like "refactor for clarity" or "improve code quality." For goals with objective metrics, hooks (`afterEach`) or self mode are sufficient.

## How It Works

**Completion audit** — The continuation prompt forces the agent to verify every requirement against actual state before marking complete. This is adversarial-by-design: the agent must prove completion, not just claim it.

**Blocked audit** — After 3 consecutive turns of the same blocker, the goal is marked blocked. Different blockers reset the counter. Resuming a blocked goal starts a fresh audit.

**Git-native** — Each iteration commits on `kept` or reverts on `reverted`. The worktree is the source of truth.

**Ideas backlog** — Promising-but-untried approaches are logged and surfaced in continuation prompts to prevent random walk.

**Iteration journal** — Every logged attempt is recorded in `.pi/goal/<id>/journal.md` with hypothesis, result, cost, and commit hash.

**Compaction-aware** — Goal state is included in compaction summaries so the loop survives context compaction.

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

- **Codex CLI** — completion audit, blocked audit, agent-set goals
- **Claude Code** — external evaluator pattern
- **Karpathy autoresearch** — git-native keep/revert, metric loop

## License

MIT
