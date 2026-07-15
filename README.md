# pi-goal

Session-scoped autonomous goals for pi. Define a verifiable completion condition and pi continues working across turns until it is complete, paused, blocked, or bounded by usage.

State lives in Pi session custom entries, so resume and `/tree` are branch-aware and forks remain independent. pi-goal never commits, resets, cleans, or runs model-supplied shell hooks.

## Installation

```bash
pi install git:github.com/nijaru/pi-goal
```

## Quick Start

```text
/goal --budget 5 --max-turns 50 all tests pass and lint is clean
```

`/goal` starts the loop directly. It does not ask the model to create a second goal or invent a budget. With no arguments, `/goal` shows status.

## User Commands

| Command | Description |
|---------|-------------|
| `/goal` | Show current goal, usage, elapsed time, and evaluation |
| `/goal <condition>` | Start with the default $5 / 50-turn limits |
| `/goal --budget 5 --max-turns 20 <condition>` | Start with explicit limits |
| `/goal edit <condition>` | Replace the current goal |
| `/goal pause` | Pause the loop |
| `/goal resume [--budget N] [--max-turns N]` | Resume a paused, blocked, or limited goal; both budget and turn headroom are required |
| `/goal clear` | Clear the goal and persist a tombstone |

Pause, resume, clear, and limit changes are deliberately user-command-only.

## Agent Tools

| Tool | Description |
|------|-------------|
| `create_goal` | Create a session-scoped goal with USD and turn bounds |
| `get_goal` | Read lifecycle, provider usage, evaluation, blocker, and progress |
| `update_goal` | Mark the goal `complete` or `blocked` only |
| `evaluate_goal` | Request an adversarial evaluation prompt or record its verdict |
| `log_iteration` | Record a bounded attempt and evidence; no Git mutation |
| `log_idea` | Add a bounded idea to the session-persisted backlog |

## Completion and safety

- **Evidence gate.** `update_goal({status: "complete"})` requires `evaluate_goal` to have recorded `achieved` with non-empty evidence for the current goal revision. Workspace-mutating tools, `user_bash`, session restart, and `/tree` reconstruction invalidate that evaluation; requesting an evaluation and then completing it does not.
- **Evaluator contract.** The extension returns an adversarial evaluation prompt, but the caller must provide a genuinely fresh, read-only evaluator context (the `subagent` handoff is supported while evaluation is pending) and judge the returned evidence. Any other workspace-mutating tool activity invalidates the request. pi-goal does not cryptographically guarantee evaluator independence.
- **Authoritative usage.** At `agent_start`, usage is bound to the goal active for that run. Each `turn_end` accounts one provider turn exactly once. The USD threshold is checked after the provider call, so one call may overshoot the budget; `maxTurns` aborts before another turn.
- **Session scope.** State is stored with `pi.appendEntry()` and reconstructed from the current session branch. `/tree` reconstructs state but does not schedule a turn until a prompt is submitted in the selected branch. Compaction may append a state snapshot while preserving Pi's normal summary. Continuations are queued through Pi's agent lifecycle, so Pi performs its auto-compaction check before draining them; there is no detached timer racing compaction.
- **Workflow safety.** While a goal is active, pi-workflows calls with background/detached execution are blocked. Use `background: false` so the workflow cannot race goal continuation.
- **No destructive automation.** Iteration labels are logical `kept`/`reverted` experiment results. pi-goal never runs Git commands or arbitrary shell hooks.
- **Serialized and bounded state.** Goal mutations are queued. Persisted notes, evidence, arrays, numbers, and limits are validated or bounded during reconstruction. Prompt data blocks escape embedded closing markers and are explicitly untrusted.

## Lifecycle

```text
active → complete       (current-revision evaluation says achieved)
active → blocked        (external input/dependency required)
active → budget_limited (USD or turn limit reached)
active → paused         (/goal pause or user interruption)
paused/blocked/limited → active (/goal resume with both limits available)
any goal state → cleared (/goal clear or replacement)
```

## Persistence

The canonical state is stored in Pi's session file as custom entries. Iterations and ideas are part of the goal state, so restart, resume, and `/tree` reconstruction do not depend on project files. A restored active goal waits for the next user prompt or explicit `/goal resume` before starting, so it cannot race Pi's initial prompt. A fork starts without inheriting the parent goal. The former project-global `.pi/goal` format is intentionally not auto-imported.

MIT
