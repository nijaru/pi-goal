# pi-goal

Persistent loop for pi. Define what "done" means, agent works until it's done.

## Architecture

- Single extension, ~900 lines
- Entry: `extensions/pi-goal/index.ts`
- Files stored in `.pi/goal/<goal-id>/`

## Scope

- No unbounded loops, budget always required
- No orchestration, that's pi-workflows
- No agent definitions, that's pi-subagents
- No separate memory extension, iteration log is built in

## Stack

- TypeScript, Bun
- Pi extension API (`@earendil-works/pi-coding-agent`)
- Pi TUI (`@earendil-works/pi-tui`)
- Pi AI types (`@earendil-works/pi-ai`)

## Testing

```bash
bun test
```

## Tools

| Tool | Key params | Notes |
|------|-----------|-------|
| `create_goal` | `objective`, `budget` | Fails if active goal exists |
| `get_goal` | (none) | Read-only state check |
| `update_goal` | `status`, `blocker?` | `complete`/`blocked`/`paused`/`cleared` |
| `log_iteration` | `hypothesis`, `result`, `cost`, `status` | `kept` commits, `reverted` resets (git repos) |
| `log_idea` | `idea` | Prevents random walk |
| `evaluate_goal` | `mode`, `analysis?`, `verdict?` | `self` or `adversarial` |

Goal statuses: `active` → `complete` | `blocked` | `budget_limited` | `paused`.
`paused` and `budget_limited` → `active` (via `/goal resume`).
`complete` and `blocked` are terminal.
Auto-continue is per-session (50 turns), resets on session start and resume.

## Key Patterns

- Completion audit: subagent with fresh context window (avoids self-evaluation bias)
- Blocked audit: 3 consecutive turns of same blocker before marking blocked
- Agent-set goals: create_goal tool enables meta-prompting
- Git-native: commit on keep, reset on revert (optional, when in a git repo)
- Iteration log: plain markdown, agent reads directly
- Ideas backlog: plain markdown, prevents random walk


