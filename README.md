# pi-goal

Session-scoped autonomous goals for pi. Define a verifiable completion condition and pi continues working across turns until it is complete, paused, blocked, or bounded by usage.

State lives in Pi session custom entries, so resume and `/tree` are branch-aware and forks remain independent. pi-goal never commits, resets, cleans, or runs model-supplied shell hooks.

## Installation

```bash
pi install git:github.com/nijaru/pi-goal
```

Requires Pi `>=0.81.0` for lifecycle-settlement and usage accounting events.

## Quick Start

```text
/goal all tests pass and lint is clean
```

`/goal` starts the loop directly with unlimited USD and turn limits. Add `--budget N` and/or `--max-turns N` when you want hard bounds. It does not ask the model to create a second goal or invent limits. With no arguments, `/goal` shows status.

## User Commands

| Command | Description |
|---------|-------------|
| `/goal` | Show current goal, usage, elapsed time, and evaluation |
| `/goal <condition>` | Start with unlimited USD and turns |
| `/goal --budget 5 --max-turns 20 <condition>` | Start with explicit hard limits; either option may be used alone (`unlimited` removes one) |
| `/goal edit <condition>` | Replace the current goal (unlimited unless limits are supplied) |
| `/goal pause` | Pause the loop |
| `/goal resume [--budget N|unlimited] [--max-turns N|unlimited]` | Resume a paused, blocked, or limited goal; only a reached limit needs new headroom |
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

`create_goal` remains available so an explicit user request can start a goal. The other five tools are dynamically active only while a goal has `active` status; their runtime guards remain in place.

## Completion and safety

- **Evidence gate.** `update_goal({status: "complete"})` requires `evaluate_goal` to have recorded `achieved` with non-empty evidence for the current goal revision. Workspace-mutating tools, `user_bash`, session restart, and `/tree` reconstruction invalidate that evaluation; requesting an evaluation and then completing it does not.
- **Evaluator contract.** The extension returns an adversarial evaluation prompt, but the caller must provide a genuinely fresh, read-only evaluator context. A single-mode `subagent` handoff containing the pending token is supported while evaluation is pending; parallel, chained, or token-smuggling calls invalidate the request. The caller still owns freshness and read-only behavior, which pi-goal cannot cryptographically guarantee.
- **Authoritative usage.** At `agent_start`, usage is bound to the goal active for that run. Each parent provider turn increments `turns` exactly once; `cost` and token totals include the parent response plus Pi-recorded nested tool, compaction, and branch-summary usage. Omitted limits are unlimited. An explicit USD threshold is checked after provider usage is reported, so one call may overshoot; an explicit `maxTurns` limit aborts before another turn. Unlimited is deliberate: Pi cannot turn a ChatGPT subscription quota or an API provider's account limit into a reliable per-goal USD ceiling. Use explicit limits when you want a local stop condition; provider and plan limits still apply.
- **Session scope.** State is stored with `pi.appendEntry()` and reconstructed from the current session branch. `/tree` reconstructs state but does not schedule a turn until a prompt is submitted in the selected branch. Compaction may append a state snapshot while preserving Pi's normal summary. Continuations are queued through Pi's agent lifecycle, so Pi performs its auto-compaction check before draining them; there is no detached timer racing compaction.
- **Workflow safety.** While a goal is active, pi-workflows calls with background/detached execution are blocked. Use `background: false` so the workflow cannot race goal continuation.
- **No destructive automation.** Iteration labels are logical `kept`/`reverted` experiment results. pi-goal never runs Git commands or arbitrary shell hooks.
- **Serialized and bounded state.** Goal mutations are queued. Persisted notes, evidence, arrays, numbers, and limits are validated or bounded during reconstruction. Prompt data blocks escape embedded closing markers and are explicitly untrusted.

## Lifecycle

```text
active → complete       (current-revision evaluation says achieved)
active → blocked        (external input/dependency required)
active → budget_limited (an explicit USD or turn limit reached)
active → paused         (/goal pause or user interruption)
paused/blocked/limited → active (/goal resume; add headroom only for a reached limit)
any goal state → cleared (/goal clear or replacement)
```

## Persistence

The canonical state is stored in Pi's session file as custom entries. Iterations and ideas are part of the goal state, so restart, resume, and `/tree` reconstruction do not depend on project files. A restored active goal waits for the next user prompt or explicit `/goal resume` before starting, so it cannot race Pi's initial prompt. A fork starts without inheriting the parent goal. The former project-global `.pi/goal` format is intentionally not auto-imported. Goal kickoffs and normal follow-ups are hidden, attributed custom messages. When an automatic turn returns prose without tool activity, pi-goal waits for the current run to settle, appends its hidden lifecycle marker, and starts one paired, lifecycle-fenced user-role follow-up so the next turn receives an actionable prompt; this avoids a separate no-op provider turn. This is an extension-API workaround, not simulated user input.

MIT
