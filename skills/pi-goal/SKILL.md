---
name: pi-goal
description: >
  Session-scoped autonomous goals for pi. Define an objective and a verifiable
  definition of done; the supervisor drives concrete progress cycles.
version: 0.4.0
---

# pi-goal

Use this loop for work with a concrete finish line. A goal must have an
objective and a definition of done. The supervisor drives one provider run at a
time and persists typed events in the current Pi session branch.

## Commands

- `/goal` — show status
- `/goal <objective>` — create and start with a default definition of done
- `/goal pause` — pause; the running response finishes first
- `/goal resume` — resume a paused or blocked goal; create a replacement after a limit stop
- `/goal clear` — clear (aliases: `stop`, `cancel`); the goal disappears from status, tools, and the widget

## Tools

- `create_goal` — create or replace a goal; provide `objective`, `doneWhen`, and optional `maxCost`, `maxTurns`, or `maxExecutionSeconds`
- `get_goal` — inspect structured state, usage, limits, progress, and evaluation
- `goal_checkpoint` — record action, observation, progress (`made`, `blocked`, or `none`), and evidence
- `evaluate_goal` — request or record an independent evaluation
- `update_goal` — mark only `complete` or `blocked`

Only `create_goal` is visible without an active goal. Runtime guards remain in
place for all other tools.

## Operating rules

1. Use one objective with a measurable `doneWhen` condition.
2. Work in explicit cycles: inspect, take one concrete action, observe the
   result, then call `goal_checkpoint` with real evidence.
3. Classify progress honestly. Failed tools and prose-only responses are not
   progress. Repeated no-progress or blocked checkpoints stop the loop with a
   diagnostic instead of spinning forever.
4. Before completion, call `evaluate_goal` without a verdict. Give its prompt to
   a genuinely fresh, read-only evaluator, then record that evaluator's verdict
   and evidence. Call `update_goal` with `complete` only for an achieved result
   bound to the current request, revision, and activity epoch.
5. Use `update_goal` with `blocked` when user input or an external dependency is
   required. Include the concrete blocker. Pause, resume, clear, replacement,
   and limit policy are user-command-only. A limit stop requires a replacement
   goal with revised limits.
6. Usage is attributed to the run lease active at provider dispatch. Parent
   turns, nested usage, and execution time are accounted idempotently. Explicit
   cost, turn, and execution-time limits are local stop conditions; provider
   account or plan quotas still apply.
7. Never mutate Git, run arbitrary shell hooks, or invoke detached/background
   workflows from an active goal.

## Runtime and persistence

The implementation uses a pure goal reducer, typed events, and one serialized
run-lease controller. Every provider-bound effect checks its lease; stale
lifecycle events cannot charge, continue, or abort a replacement run.

Pi's selected session branch is the durable authority. Compaction writes a
reducer snapshot. Restart reconstructs state but does not start work until user
input or `/goal resume`; forks clear inherited goals. The current schema and
API are intentionally new and do not migrate the former state or patch format.
