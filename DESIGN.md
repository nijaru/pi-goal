# pi-goal

Persistent loop. Define what "done" means, agent works until it's done.

## Why

Goal mode (Claude Code, Codex) and autoresearch (Karpathy) are the same pattern: a persistent loop that tries, evaluates, keeps or reverts, and repeats until done. One extension handles both.

## Core Loop

```
1. Define goal (what "done" means + budget)
2. Agent makes a change
3. Evaluate (did it get closer to done?)
4. Keep or revert
5. Repeat until done or budget exhausted
```

## API

### Create a goal

```js
// Agent creates its own goal (meta-prompting)
const goal = await create_goal({
  objective: "all tests pass and lint is clean",
  budget: 5.00,
});

// Agent creates goal for a subagent
const goal = await create_goal({
  objective: "Fix auth module tests",
  budget: 2.00,
});
```

### Run an iteration

```js
// Agent logs what it tried
await log_iteration({
  hypothesis: "Add caching layer to reduce latency",
  result: "p95 improved from 250ms to 210ms",
  cost: 0.03,
  status: "kept",
});
```

### Evaluate (optional)

The continuation template includes a completion audit (adversarial-by-design). For extra confidence, use evaluate_goal:

```js
// Self mode — agent evaluates its own progress
await evaluate_goal({
  mode: "self",
  analysis: "All 47 auth tests pass, lint is clean",
  verdict: "achieved",
  reasoning: "Verified via npm test and npm run lint",
});

// Adversarial mode — returns prompt for subagent with fresh context
const result = await evaluate_goal({ mode: "adversarial" });
// Agent spawns subagent with result.prompt for objective evaluation
```

### Keep/revert

Git-native (when in a git repo). Commit on keep, `git reset` on revert. Each iteration is a checkpoint. Outside a git repo, iterations are logged to journal only.

### Ideas backlog

Promising-but-untried approaches logged to prevent random walk:

```js
await log_idea({ idea: "Try connection pooling instead of caching" });
```

## Goal Lifecycle

```
active → complete      (goal met, verified via completion audit)
active → blocked       (same blocker for 3+ consecutive turns)
active → budget_limited (budget exhausted)
active → paused        (user action)
paused → active        (user resumes)
```

## Convergence

Stop when:
- Goal is complete (completion audit passes, agent calls update_goal)
- Goal is blocked (3+ turns of same blocker)
- Budget exhausted

## Hooks

```js
await create_goal({
  objective: "all tests pass",
  budget: 5.00,
  beforeEach: "git stash && git checkout baseline",
  afterEach: "npm test",
});
```

## Iteration Log

Each iteration stores a record in `.pi/goal/<goal-id>/journal.md`:

```markdown
# Iteration Log

## Iteration 1 — 2026-06-14T10:30:00Z
- Hypothesis: Add caching layer to reduce latency
- Result: p95_latency_ms improved from 250 to 210
- Cost: $0.03
- Status: kept

## Iteration 2 — 2026-06-14T10:35:00Z
- Hypothesis: Increase cache TTL to 5 minutes
- Result: p95_latency_ms worsened to 280 (cache invalidation issues)
- Cost: $0.02
- Status: reverted
```

This is the iteration history. The agent reads it to avoid repeating failed approaches. No separate memory system needed — just a markdown file.

## Ideas Backlog

Promising-but-untried approaches in `.pi/goal/<goal-id>/ideas.md`:

```markdown
# Ideas

- Try connection pooling instead of caching — current approach hit race conditions
- Consider async I/O for the database layer
- Look into connection multiplexing
```

## Dashboard

Widget (compact): iteration count, progress, cost
Panel (full): history, metrics, cost breakdown, hooks, ideas

## Tool Model

| Tool | Role | Notes |
|------|------|-------|
| create_goal | Agent/user | Sets objective + budget |
| get_goal | Read-only | Check state |
| update_goal | Agent | After completion audit |
| evaluate_goal | Optional | Self or adversarial evaluation |
| log_iteration | Agent | Record iteration, checkpoint if in git repo |
| log_idea | Agent | Anti-random-walk |

## What This Doesn't Do

- No unbounded loops — budget always required
- No orchestration — that's pi-workflows
- No agent definitions — that's pi-subagents
- No separate memory extension — iteration log is built in

## Influences

### Loop Patterns

- **Ralph Loop** (Geoffrey Huntley, 2025) — `while :; do cat PROMPT.md | claude; done`. Fresh context each iteration, task completion via completion promise or test results. Ralph proved the simplest viable loop. Pi-goal inherits the "loop until done" skeleton but adds persistent state (Ralph discards context each iteration).

- **Autoresearch** (Karpathy, 2025) — Single mutable file, metric-driven, git-native keep/revert, never stops. Pi-goal inherits git-native checkpointing and the keep/revert pattern, but adds explicit stopping criteria.

- **Ralph Loop Optimizer** (haoran-ni) — Bridges Ralph and autoresearch: domain-agnostic optimization with Ralph-style orchestration + autoresearch-style evaluation logging. Closest prior art to pi-goal's design.

### Goal Implementations

- **Codex CLI /goal** — Server-side SQLite persistence, model self-decides completion. Pi-goal uses file-based persistence (same idea, local-first). Codex has no hard cost budget; pi-goal does.

- **Claude Code /goal** — Separate evaluator model (Haiku) with fresh context window. Confirmed the "never self-evaluate" pattern. Pi-goal uses the same fresh-context principle with subagent.

### Evaluation Research

- **Agent-as-a-Judge** (ICML 2025) — Agentic evaluation with intermediate feedback outperforms single LLM calls. Validates pi-goal's adversarial evaluation approach.
- **SELFGOAL** — Hierarchical goal decomposition (future consideration).

## File Structure

```
.pi/goal/<goal-id>/
├── journal.md     # iteration log (what was tried, result, cost)
├── ideas.md       # promising-but-untried approaches
└── state.json     # goal state (budget, status, lifecycle)
```

## Implementation Notes

- ~700 lines, single file
- Git-native keep/revert (commit on kept, checkout on reverted) — when in a git repo
- Cost in USD (self-reported by agent, not automatic token counting)
- Evaluator: adversarial mode uses fresh context (subagent preferred, fresh turn fallback) to avoid self-evaluation bias
- Evidence: iterations should include command output/test results; claims without evidence are weaker
- Stagnation: warns when last 3 iterations have same hypothesis or all reverted
- Hooks via pi's bash tool (beforeEach/afterEach)
- Dashboard via pi's widget
- Convergence: blocked audit (3 consecutive same-blocker turns)
- Evaluation: completion audit requires fresh context (subagent or fresh turn) to avoid self-evaluation bias
- Completion: widget stays visible for 3 turns after terminal state, then auto-clears
- Influenced by Codex CLI, Claude Code, Karpathy autoresearch
