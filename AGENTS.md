# pi-goal

Persistent goal loop for pi. Define what "done" means; the agent works until it is complete, paused, blocked, or an explicitly configured limit is reached.

## Architecture

- Single extension entry: `extensions/pi-goal/index.ts`
- Canonical state: Pi session custom entries via `pi.appendEntry("pi-goal/state", ...)`
- Goal scope: current Pi session branch; reconstruction is branch-aware and forks intentionally start independently to avoid cross-session goal races

## Scope

- Goals default to unlimited USD and turns; explicit user-provided limits remain hard bounds
- No orchestration: that belongs to pi-workflows
- No agent definitions: that belongs to pi-subagents
- No destructive Git automation or arbitrary model-supplied shell hooks
- Model-facing `update_goal` only accepts `complete` and `blocked`; user commands own pause, resume, clear, and limit changes

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
| `create_goal` | `objective`, optional `budget`, optional `maxTurns` | Omitted limits are unlimited; fails if a nonterminal goal exists |
| `get_goal` | (none) | Read-only state and usage |
| `update_goal` | `status: complete\|blocked`, `blocker?` | Completion requires current-revision evaluation with evidence |
| `evaluate_goal` | `verdict?`, `reason?`, `evidence?` | Caller supplies fresh context; achieved requires non-empty evidence |
| `log_iteration` | `hypothesis`, `result`, `status`, `cost?`, `evidence?` | Logical kept/reverted labels only; no Git changes |
| `log_idea` | `idea` | Session-persisted bounded backlog |

Statuses: `active` → `complete` | `blocked` | `budget_limited` | `paused` | `cleared`.

## Design rules

- Mutating tool operations and usage/accounting updates run through one async queue; lifecycle callbacks fence run ownership before they schedule or account work.
- Attribute usage to the owning goal generation; account one parent provider response per `turn_end`, persist every turn, check each explicitly configured USD limit after the call, and abort before another turn at an explicitly configured `maxTurns`.
- A single provider call may overshoot an explicit USD budget. Resuming paused, blocked, or limited goals requires headroom only for a reached limit; command paths share centralized finite/positive/bounds validation.
- State is validated and bounded during reconstruction. The newest state entry is authoritative, and clear/replacement tombstones prevent stale resurrection.
- Prompt-injected objective/evidence/notes are bounded, escaped against embedded data-block markers, and clearly marked as untrusted data.
- Compaction adds a goal snapshot without replacing Pi's normal summary. Automatic continuations use Pi's agent-lifecycle queue, allowing Pi's auto-compaction check to finish before follow-ups are drained.
- Restored active goals wait for the next user prompt or explicit `/goal resume` before starting, avoiding a race with Pi's initial prompt. `/tree` reconstruction does not schedule work before a prompt is submitted in the selected branch. Explicit kickoffs and normal lifecycle continuations use hidden, attributed custom messages; prose-only automatic turns wait for settlement, then append the hidden marker and start one paired, lifecycle-fenced user-role follow-up because the extension API lacks Pi's internal developer-context path.
- Workspace-mutating tool activity, `user_bash`, session restart, and `/tree` reconstruction invalidate recorded evaluations. `evaluate_goal` followed by `update_goal complete` is not itself a mutation. Fresh-context evaluator independence is caller-enforced, not automatic or cryptographic.
- While a goal is active, block detached/background `workflow` calls from pi-workflows unless `background: false` is explicit; pi-goal does not orchestrate workflows.
- Completion is gated by an `achieved` evaluation whose revision matches the goal revision and whose evidence is non-empty. The caller supplies a genuinely fresh, read-only evaluator (the pending `subagent` handoff is supported); the extension does not invoke or cryptographically attest a second model.
