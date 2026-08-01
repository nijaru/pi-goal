---
name: pi-goal
description: >
  Session-scoped persistent goals for pi. Define what "done" means, and the
  agent works until it is complete, paused, blocked, or bounded.
version: 0.3.0
---

# pi-goal

Use this continuation loop for long-running work with a concrete, verifiable finish line. Limits are optional; use a normal prompt for one-shot tasks.

## Commands

- `/goal` — show status
- `/goal <objective>` — create and start with unlimited USD and turns
- `/goal --budget N --max-turns N <objective>` — create with explicit hard limits; either option may be used alone (`unlimited` removes one)
- `/goal edit <objective>` — replace the current goal
- `/goal pause` — pause
- `/goal resume [--budget N|unlimited] [--max-turns N|unlimited]` — resume a paused, blocked, or limited goal; only a reached limit needs new headroom
- `/goal clear` — clear and persist a tombstone

Pause, resume, clear, and budget/maxTurns changes are user-command-only.

## Tools

- `create_goal` — create a session-scoped goal; optional `budget` and `maxTurns` are hard bounds, omitted limits are unlimited
- `get_goal` — inspect state, provider usage, evaluation, blocker, and progress
- `update_goal` — mark only `complete` or `blocked`; it cannot pause, resume, clear, or change limits
- `evaluate_goal` — request an adversarial evaluation prompt, then record `achieved`, `not_yet`, or `error`
- `log_iteration` — record a bounded logical attempt and evidence
- `log_idea` — record a bounded idea

`create_goal` remains visible for explicit user requests. `get_goal`, `update_goal`, `evaluate_goal`, `log_iteration`, and `log_idea` are dynamically hidden unless a goal is active; runtime guards still reject invalid direct calls.

## Operating rules

1. Use one objective with a measurable stopping condition and verification surface.
2. Call `log_iteration` after meaningful attempts and include command/test output.
3. Before completion, request `evaluate_goal` with no verdict. The caller must give its prompt to a genuinely fresh, read-only evaluator (the `subagent` handoff is supported while evaluation is pending), record that evaluator's verdict and non-empty evidence, then call `update_goal` with `complete` only if it says `achieved` for the current revision. Any other workspace-mutating tool activity invalidates the request; evaluator independence remains caller-enforced.
4. Use `blocked` when user input or an external dependency is required; include the concrete blocker.
5. Usage is scoped to the goal active at `agent_start` and accounted once per `turn_end`. Omitted limits are unlimited. An explicit USD threshold is post-provider-call, so one call may overshoot; an explicit `maxTurns` aborts before another turn. Pi's local budget is optional policy, not a replacement for provider or ChatGPT-plan quotas.
6. Workspace-mutating tool activity, `user_bash`, session restart, and `/tree` reconstruction invalidate a recorded evaluation. `evaluate_goal` followed by `update_goal complete` does not.
7. While a goal is active, invoke pi-workflows only with `background: false`; detached/background workflows are blocked to prevent continuation races.
8. `kept` and `reverted` are logical labels. pi-goal never mutates Git or runs arbitrary shell hooks.

## Lifecycle

`active` → `complete` | `blocked` | `budget_limited` (only when an explicit limit is reached) | `paused` | `cleared`.

Goals are persisted as Pi session custom entries and reconstructed from the current branch. A restored active goal waits for the next user prompt or explicit `/goal resume` before starting, avoiding a race with Pi's initial prompt. `/tree` reconstructs the selected state but does not schedule work before the selected prompt is resubmitted, and invalidates prior evaluation evidence. Compaction keeps Pi's normal summary. Kickoffs and normal continuations use hidden, attributed custom messages queued through Pi's retry and compaction-safe lifecycle. If an automatic turn returns prose without tool activity, pi-goal waits for the current run to settle, appends its hidden lifecycle marker, and starts one paired, lifecycle-fenced user-role follow-up so the next turn receives an actionable prompt without a separate no-op provider turn; this is an extension-API workaround.
