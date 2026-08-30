# pi-goal

Session-scoped autonomous goals for Pi. Define an objective and an explicit,
verifiable definition of done; the supervisor drives concrete work cycles until
completion, pause, block, limit, or clear.

## Architecture

- Entry point: `extensions/pi-goal/index.ts`
- Domain reducer: `extensions/pi-goal/domain.ts`
- Branch event store: `extensions/pi-goal/store.ts`
- Serialized controller: `extensions/pi-goal/controller.ts`
- Canonical state: typed `pi-goal/event` entries in the selected Pi session branch
- Compaction checkpoint: typed `pi-goal/snapshot` entry
- Runtime ownership: explicit run leases; never a durable authority

## Scope

- Goal creation requires `objective` and `doneWhen`; optional hard limits are USD cost, provider turns, and active execution seconds
- `goal_checkpoint` owns inspect/action/observation/progress evidence; repeated no-progress or blocked cycles stop the loop
- Completion requires a fresh read-only evaluation bound to the current revision, activity epoch, and request ID
- No orchestration: that belongs to pi-workflows
- No agent definitions: that belongs to pi-subagents
- No destructive Git automation, arbitrary model-supplied shell hooks, or detached/background workflow work
- Model-facing `update_goal` accepts only `complete` and `blocked`; user commands own pause, resume, clear, and replacement. A limit stop requires a replacement with revised limits
- Compatibility with the former schema, patch protocol, and project-global `.pi/goal` state is intentionally not supported

## Stack and tests

- TypeScript, Bun
- Pi extension API (`@earendil-works/pi-coding-agent`), Pi `>=0.81.0`
- Pi TUI (`@earendil-works/pi-tui`)
- Pi AI types (`@earendil-works/pi-ai`)

```bash
bun test
bunx tsc --noEmit
git diff --check
```

## Tool contract

| Tool | Key params | Notes |
|------|-----------|-------|
| `create_goal` | `objective`, `doneWhen`, optional `maxCost`, `maxTurns`, `maxExecutionSeconds` | Creates or replaces the current goal |
| `get_goal` | (none) | Read-only structured state, limits, usage, progress, and evaluation |
| `goal_checkpoint` | `action`, `observation`, `progress`, `evidence` | Required cycle evidence; progress is `made`, `blocked`, or `none` |
| `evaluate_goal` | `requestId?`, `verdict?`, `reason?`, `evidence?` | Caller supplies a fresh evaluator; achieved requires evidence |
| `update_goal` | `status: complete\|blocked`, `blocker?` | Completion requires the exact achieved evaluation |

Statuses: `active` → `complete` | `blocked` | `limited` | `paused` | `cleared`; only paused or blocked goals resume in place.

## Design rules

- Domain transitions are pure and reducers reject stale run leases, revisions, and event sequences.
- The event store is the only durable owner; replay is branch-scoped, bounded, idempotent by event ID, and snapshot-aware.
- The controller serializes all goal mutations and external effects. Every provider dispatch has one run lease; stale lifecycle events cannot charge, continue, or abort replacement work.
- Parent turns, nested usage, and execution time are accounted independently and idempotently. Limits are local stop conditions, not provider-plan quotas.
- User input supersedes pending continuations. Unacknowledged continuation delivery blocks after a bounded timeout rather than leaving an active goal stranded.
- Restart and tree reconstruction do not auto-run. Forks clear inherited goals. Compaction pauses an interrupted run, snapshots state, and resumes through one recovery continuation after success.
- Progress checkpoints are bounded and include concrete evidence. Failed tools and prose-only cycles do not count as progress.
- Evaluation claims are invalidated by workspace/tool activity, user steering, tree changes, compaction, replacement, and lifecycle context changes. Fresh evaluator independence is caller-enforced.
- No compatibility shims, duplicate state authorities, Git mutation, or arbitrary shell hooks.
