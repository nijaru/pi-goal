# pi-goal

Persistent loop for pi. Define what "done" means, agent works until it's done.

## Design

API examples, lifecycle, convergence, and file formats are documented in the code and README.

## Architecture

- Single extension, ~900 lines
- Entry: `extensions/pi-goal/index.ts`
- Files stored in `.pi/goal/<goal-id>/`
- Git-native keep/revert (when in a git repo)
- Adversarial evaluation (different model than agent)
- Ideas backlog to prevent random walk

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

## Key Patterns

- Completion audit: subagent with fresh context window (avoids self-evaluation bias)
- Blocked audit: 3 consecutive turns of same blocker before marking blocked
- Agent-set goals: create_goal tool enables meta-prompting
- Git-native: commit on keep, reset on revert (optional, when in a git repo)
- Iteration log: plain markdown, agent reads directly
- Ideas backlog: plain markdown, prevents random walk

## Influences

- Codex CLI — completion audit, blocked audit, agent-set goals
- Claude Code — external evaluator pattern
- Karpathy autoresearch — git-native keep/revert, metric loop
