# pi-goal

Session-scoped autonomous goals for Pi. Define an objective and an explicit
verifiable definition of done; pi-goal drives concrete work cycles until the
goal is complete, paused, blocked, limited, or cleared.

The supervisor is built around a pure state reducer, typed events, a
branch-aware Pi session store, and a serialized run-lease controller. It never
mutates Git, runs arbitrary model-supplied shell hooks, or launches detached
workflows.

## Installation

```bash
pi install git:github.com/nijaru/pi-goal
```

Requires Pi `>=0.81.0`.

## Quick start

```text
/goal all tests pass and lint is clean
```

The command uses a default definition of done. For model-created goals, use
both fields explicitly:

```text
create_goal({
  "objective": "make the parser reject malformed input",
  "doneWhen": "the focused tests and the full test suite pass"
})
```

## Commands

| Command | Description |
|---------|-------------|
| `/goal` | Show status, limits, execution time, progress, and blocker |
| `/goal <objective>` | Start an unlimited goal |
| `/goal pause` | Pause the active goal |
| `/goal resume` | Resume a paused or blocked goal |
| `/goal clear` | Clear the goal |

## Tools

| Tool | Description |
|------|-------------|
| `create_goal` | Create or replace a goal with `objective`, `doneWhen`, and optional `maxCost`, `maxTurns`, and `maxExecutionSeconds` |
| `get_goal` | Read structured state, usage, limits, progress, and evaluation |
| `goal_checkpoint` | Record the action, observation, progress classification, and evidence for a cycle |
| `evaluate_goal` | Request or record a fresh read-only completion evaluation |
| `update_goal` | Complete or block the goal |

The model-facing protocol is intentionally explicit:

```text
inspect → action → observation → goal_checkpoint → continue or stop
```

A prose-only cycle is recorded as no progress. Repeated no-progress or blocked
cycles stop the supervisor with a concrete diagnostic.

## Completion and safety

- Completion requires a fresh, read-only evaluator to return `achieved` with
  non-empty evidence.
- The evaluation must match the current goal revision, activity epoch, and
  request ID. Tool activity, user steering, tree changes, and compaction
  invalidate stale claims.
- Usage is recorded once per provider turn. Execution time is recorded
  independently, in whole seconds, and may be bounded with
  `maxExecutionSeconds`.
- Run leases prevent stale retries, continuations, reloads, compactions, and
  user-interrupted work from charging or controlling a replacement run.
- User commands own pause, resume, clear, and replacement. A limit stop requires
  creating a replacement with revised limits. The model can only complete or
  block through `update_goal`.
- Pi-goal does not commit, reset, clean, or execute arbitrary shell hooks.

## Persistence and architecture

Typed goal events are stored in the selected Pi session branch and replayed
through the reducer. Compaction writes a reducer snapshot; restart reconstructs
state but does not start work until user input or `/goal resume`. Forks clear
inherited goals. Runtime ownership is ephemeral and is never treated as
persistent truth.

The implementation is intentionally a new schema and API. It does not import
or migrate the former project-global `.pi/goal` format or the previous
snapshot/patch protocol.

## Development

```bash
bun test
bunx tsc --noEmit
git diff --check
```

MIT
