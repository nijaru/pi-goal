# pi-goal

Persistent loop for pi. Define what "done" means, agent works until it's done.

## Design

See DESIGN.md for the full API design and implementation notes.

## Architecture

- Single extension, ~300-400 lines
- Entry: `extensions/pi-goal/index.ts`
- Files stored in `.pi/goal/<goal-id>/`
- Git-native keep/revert
- Adversarial evaluation (different model than agent)
- Ideas backlog to prevent random walk

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

- Completion audit: built into continuation template (adversarial-by-design)
- Blocked audit: 3 consecutive turns of same blocker before marking blocked
- Agent-set goals: create_goal tool enables meta-prompting
- Git-native: commit on keep, reset on revert
- Iteration log: plain markdown, agent reads directly
- Ideas backlog: plain markdown, prevents random walk

## Influences

- Codex CLI — completion audit, blocked audit, agent-set goals
- Claude Code — external evaluator pattern
- Karpathy autoresearch — git-native keep/revert, metric loop
