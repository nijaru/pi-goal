# pi-goal

Session-scoped autonomous goals for Pi. Define one concrete objective; the
supervisor continues it after idle provider runs until the model completes or
blocks it.

## Architecture

- Entry point: `extensions/pi-goal/index.ts`
- Domain reducer: `extensions/pi-goal/domain.ts`
- Branch event store: `extensions/pi-goal/store.ts`
- Serialized controller: `extensions/pi-goal/controller.ts`
- Canonical state: typed `pi-goal/event` entries in the selected Pi session branch
- Compaction snapshot: typed `pi-goal/snapshot` entry
- Runtime ownership: one ephemeral provider run and one queued continuation

## Scope

- Goals are opt-in and should be used only for explicit, genuinely continuing work.
- The model-facing API follows Codex: `create_goal`, `get_goal`, and
  `update_goal` (`complete` or `blocked`).
- `create_goal` takes one objective and fails while another goal is unfinished.
- Completion is the model's responsibility. There is no mandatory checkpoint or
  separate evaluator protocol.
- User commands own pause, resume, clear, and replacement. User lifecycle
  actions release the run without aborting the in-flight response.
- Cleared goals are terminal and hidden from every surface. A new goal can be
  created after a goal is cleared or completed.
- No destructive Git automation, arbitrary model-supplied shell hooks, detached
  workflows, or extension-level hard budgets.

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
|------|------------|-------|
| `create_goal` | `objective` | Explicit autonomous work only; fails for an unfinished goal |
| `get_goal` | (none) | Read-only structured state and usage |
| `update_goal` | `status: complete\|blocked` | Model marks terminal goal state |

Statuses: `active` → `complete` | `blocked` | `paused` | `cleared`; only paused or blocked goals resume in place.

## Design rules

- Domain transitions are pure and reject stale run leases and event sequences.
- The event store is the only durable owner; replay is branch-scoped, bounded,
  idempotent by event ID, and snapshot-aware.
- The controller serializes goal mutations and continuation dispatches.
- Parent turns and execution time are accounted independently and idempotently.
- User input supersedes pending continuations. Unacknowledged continuation
  delivery blocks after a bounded timeout instead of leaving an active goal stranded.
- Restart and tree reconstruction do not auto-run. Forks clear inherited goals.
- Compaction snapshots state and resumes through one recovery continuation after
  successful manual compaction.
- Former schemas are intentionally ignored rather than migrated.
