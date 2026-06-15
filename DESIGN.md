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

### Set a goal

```js
// Natural language condition
const goal = await goal({
  name: "migrate-auth-to-paseto",
  done: "all tests pass and lint is clean",
  budget: 5.00,
});

// Numeric metric
const goal = await goal({
  name: "optimize-auth-latency",
  done: "p95_latency_ms below 200",
  budget: 5.00,
});

// Test command
const goal = await goal({
  name: "fix-all-failing-tests",
  done: "npm test passes",
  budget: 3.00,
});
```

### Run an iteration

```js
const iteration = await goal.run(async (ctx) => {
  const change = await agent(`Optimize: ${ctx.hypothesis}`, {
    taskType: "implement",
    label: "optimizer",
  });
  await apply(change);
  const metric = await measure();
  return { metric, change };
});
```

### Evaluate

Adversarial evaluation — a different model checks if the goal is met. Never self-evaluate.

```js
// For condition-driven goals
const evaluator = await agent("Has the goal been achieved? Check actual artifacts.", {
  taskType: "review",
  label: "evaluator",
});
```

### Keep/revert

Git-native. Commit on keep, `git reset` on revert. Each iteration is a checkpoint.

### Ideas backlog

Promising-but-untried approaches logged to prevent random walk:

```js
goal.logIdea("Try connection pooling instead of caching — current approach hit race conditions");
const ideas = goal.getIdeas();
```

## Goal Lifecycle

```
pursuing → achieved    (goal met)
pursuing → unmet       (external blocker)
pursuing → budget_limited (token budget exhausted)
pursuing → paused      (user action)
paused   → pursuing    (user resumes)
```

## Convergence

Stop when:
- Goal is achieved (adversarial evaluation confirms)
- Budget exhausted
- No improvement for N iterations (plateau detection)

## Hooks

```json
{
  "beforeEach": "git stash && git checkout baseline",
  "afterEach": "npm test"
}
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

## Task-Type Routing

Different roles get different models:

| Role | Task Type | Default Tier |
|------|-----------|--------------|
| Optimizer | `implement` | medium |
| Evaluator | `review` | big |

## What This Doesn't Do

- No self-evaluation — adversarial only
- No unbounded loops — budget always required
- No orchestration — that's pi-workflows
- No agent definitions — that's pi-subagents
- No separate memory extension — iteration log is built in

## File Structure

```
.pi/goal/<goal-id>/
├── journal.md     # iteration log (what was tried, result, cost)
├── ideas.md       # promising-but-untried approaches
└── state.json     # goal state (budget, status, lifecycle)
```

## Implementation Notes

- ~300-400 lines across a few files
- Git-native keep/revert
- Cost tracking from pi's token counts
- Hooks via pi's bash tool
- Dashboard via pi's widget/panel
- Convergence: sliding window + plateau detection
- Evaluation: adversarial (different model than agent)
