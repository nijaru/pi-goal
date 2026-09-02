# pi-goal

Session-scoped autonomous goals for Pi. Create a goal only when the user
explicitly asks for autonomous, continuing work; Pi resumes it after each idle
provider run until the model completes or blocks it.

## Installation

```bash
pi install git:github.com/nijaru/pi-goal
```

Requires Pi `>=0.81.0`.

## Quick start

```text
/goal keep working until the parser tests and lint pass
```

The model can also create a goal explicitly:

```text
create_goal({"objective": "make the parser reject malformed input"})
```

## Commands

| Command | Description |
|---------|-------------|
| `/goal` | Show the current goal and usage |
| `/goal <objective>` | Start a goal when no unfinished goal exists |
| `/goal pause` | Pause the goal |
| `/goal resume` | Resume a paused or blocked goal |
| `/goal clear` | Clear the goal (`stop` and `cancel` are aliases) |

## Tools

| Tool | Description |
|------|-------------|
| `create_goal` | Create a goal with a concrete objective; fails while another goal is unfinished |
| `get_goal` | Read the current goal, status, usage, and blocker |
| `update_goal` | Mark the goal `complete` or `blocked` |

The model-facing protocol is deliberately small:

```text
create_goal → work → update_goal(complete|blocked)
```

Completion is the model's responsibility, as it is in Codex's goal extension.
There is no mandatory checkpoint or fake independent evaluator round-trip.

## Runtime and persistence

Goal state is stored as typed events in the selected Pi session branch and
replayed by a pure reducer. Runtime state owns one provider run and one queued
continuation. A user prompt supersedes a queued continuation without aborting
the user's work. Restart reconstructs state but does not start work until user
input or `/goal resume`; forks start without the parent goal.

The current schema and API are intentionally new. Former goal events and the
old patch protocol are ignored rather than migrated.

## Development

```bash
bun test
bunx tsc --noEmit
git diff --check
```

MIT
