# pi-goal

Persistent, bounded loop for pi. Define what "done" means; the agent works until it is complete, paused, blocked, or bounded.

## Architecture

- Single extension entry: `extensions/pi-goal/index.ts`
- Canonical state: Pi session custom entries via `pi.appendEntry("pi-goal/state", ...)`
- Goal scope: current Pi session branch; reconstruction is branch-aware and forks intentionally start independently to avoid cross-session goal races

## Scope

- No unbounded loops: every goal has USD and max-turn limits
- No orchestration: that belongs to pi-workflows
- No agent definitions: that belongs to pi-subagents
- No destructive Git automation or arbitrary model-supplied shell hooks
- Model-facing `update_goal` only accepts `complete` and `blocked`; user commands own pause, resume, clear, and limit changes

## Stack and tests

- TypeScript, Bun
- Pi extension API (`@earendil-works/pi-coding-agent`)
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
| `create_goal` | `objective`, `budget`, `maxTurns?` | Fails if a nonterminal goal exists |
| `get_goal` | (none) | Read-only state and usage |
| `update_goal` | `status: complete\|blocked`, `blocker?` | Completion requires current-revision evaluation with evidence |
| `evaluate_goal` | `verdict?`, `reason?`, `evidence?` | Caller supplies fresh context; achieved requires non-empty evidence |
| `log_iteration` | `hypothesis`, `result`, `status`, `cost?`, `evidence?` | Logical kept/reverted labels only; no Git changes |
| `log_idea` | `idea` | Session-persisted bounded backlog |

Statuses: `active` → `complete` | `blocked` | `budget_limited` | `paused` | `cleared`.

## Design rules

- Mutating tools and lifecycle handlers run through one async queue; Pi may execute sibling tool calls concurrently.
- Bind usage to the goal active at `agent_start`; account one provider response per `turn_end`, persist every turn, check USD after the call, and abort before another turn at `maxTurns`.
- A single provider call may overshoot the USD budget. Resuming paused, blocked, or limited goals requires both budget and max-turn headroom; command paths share centralized finite/positive/bounds validation.
- State is validated and bounded during reconstruction. The newest state entry is authoritative, and clear/replacement tombstones prevent stale resurrection.
- Prompt-injected objective/evidence/notes are bounded, escaped against embedded data-block markers, and clearly marked as untrusted data.
- Compaction may append a goal snapshot but never substitutes Pi's normal summary or intentionally starts a continuation during compaction. Continuations are queued through Pi's agent lifecycle, allowing Pi's auto-compaction check to finish before follow-ups are drained.
- Restored active goals wait for the next user prompt or explicit `/goal resume` before starting, avoiding a race with Pi's initial prompt. `/tree` reconstruction does not schedule work before a prompt is submitted in the selected branch. Normal goal turns use queued agent-lifecycle follow-ups.
- Workspace-mutating tool activity, `user_bash`, session restart, and `/tree` reconstruction invalidate recorded evaluations. `evaluate_goal` followed by `update_goal complete` is not itself a mutation. Fresh-context evaluator independence is caller-enforced, not automatic or cryptographic.
- While a goal is active, block detached/background `workflow` calls from pi-workflows unless `background: false` is explicit; pi-goal does not orchestrate workflows.
- Completion is gated by an `achieved` evaluation whose revision matches the goal revision and whose evidence is non-empty. The caller supplies a genuinely fresh, read-only evaluator (the pending `subagent` handoff is supported); the extension does not invoke or cryptographically attest a second model.
