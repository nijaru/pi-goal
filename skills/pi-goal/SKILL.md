---
name: pi-goal
description: >
  Session-scoped autonomous goals for pi. Create an explicit objective and let
  the supervisor continue it across idle provider runs.
version: 0.5.0
---

# pi-goal

Use this loop only for work the user explicitly wants Pi to continue. The
supervisor persists one goal in the current session branch and starts one
follow-up provider run after each settled cycle.

## Commands

- `/goal` — show status and usage
- `/goal <objective>` — create and start a goal when no unfinished goal exists
- `/goal pause` — pause; resume with `/goal resume`
- `/goal resume` — resume a paused or blocked goal
- `/goal clear` — clear (aliases: `stop`, `cancel`)

## Tools

- `create_goal` — create a goal with one concrete `objective`; use only when
  explicitly requested and only when no unfinished goal exists
- `get_goal` — inspect the current goal, status, usage, and blocker
- `update_goal` — mark the goal `complete` or `blocked`

Only `create_goal` is visible without an active goal. Runtime guards remain in
place for the other tools.

## Operating rules

1. Use `create_goal` only for explicit autonomous work, not ordinary requests.
2. Work toward the objective with the available tools. Do not reply with a plan
   only.
3. Call `update_goal` with `complete` only when the objective is actually done.
   Call `blocked` only when work cannot continue without user input or an
   external change.
4. User commands own pause, resume, clear, and replacement. Creating a goal
   while another is paused, blocked, or active fails; clear it or finish it
   first.
5. Usage is recorded once per provider response and execution time is recorded
   between lifecycle events. There are no extension-level hard budgets: the
   provider and Pi retain ownership of cancellation and plan limits.
6. Never mutate Git, run arbitrary shell hooks, or invoke detached/background
   workflows from an active goal.

## Runtime and persistence

The implementation uses a pure reducer, typed branch events, and one serialized
controller. Runtime state owns one provider run and one queued continuation.
A user prompt supersedes a queued continuation without aborting user work.

Pi's selected session branch is the durable authority. Compaction writes a
snapshot. Restart reconstructs state but does not start work until user input
or `/goal resume`; forks start without the parent goal. The current schema and
API are intentionally new; former goal events and patch data are ignored rather
than migrated.
