---
name: pi-goal
description: >
  Persistent loop for pi. Define what "done" means, agent works until it's done.
  Use when the user says "goal", "optimize", "iterate until", "keep working until",
  or wants to run an autonomous optimization loop.
version: 0.0.1
---

# pi-goal

Persistent loop that tries, evaluates, keeps or reverts, and repeats until done.

## Commands

- `/goal <objective>` — create a goal
- `/goal status` — show current goal
- `/goal pause` — pause the goal loop
- `/goal resume` — resume a paused or budget-limited goal
- `/goal clear` — clear the goal (deletes goal directory)

## Tools

- `create_goal` — set objective + budget (agent or user)
- `get_goal` — read current goal state
- `update_goal` — mark complete or blocked
- `evaluate_goal` — generate an adversarial evaluation prompt for fresh-context review. The evaluator looks for gaps and failures, not confirms completeness. Only mark complete after the evaluator confirms achievement.
- `log_iteration` — record iteration, git commit/revert
- `log_idea` — ideas backlog (anti-random-walk)

## When to Use

- User wants to optimize something (performance, coverage, etc.)
- User wants to iterate until a condition is met
- User wants autonomous work on a long-running task
- User says "keep working until X"
- Agent should set goals for itself or subagents (meta-prompting)

## How It Works

1. Create a goal with an objective and budget
2. Continuation template includes completion audit (adversarial-by-design)
3. Agent makes changes, logs iterations
4. Agent calls update_goal when objective is verified against actual state
5. Repeat until complete, blocked, or budget exhausted

## Key Patterns

- **Completion audit** — call evaluate_goal before marking complete. The adversarial prompt checks for gaps, weak evidence, and unverified claims. Fresh context (subagent or fresh turn) corrects for self-preferential bias.
- **Blocked audit** — call update_goal({status: "blocked"}) each time you hit a blocker. The tool tracks consecutive calls with the same blocker description — it marks blocked after the 3rd call. This gives the agent intermediate feedback (1/3, 2/3) before actually blocking.
- **Auto-continue** — per-session limit (50 turns). Limit resets on session start and resume. Hitting the limit pauses the goal (doesn't brick it).
- **Budget-limited resumable** — goals that exhaust their budget can be resumed via `/goal resume` (unlike Codex, where budget-limited is terminal). Increase budget or clear and recreate.
- **Stagnation detection** — warns when 3 consecutive iterations have the same hypothesis or are all reverted.
- **Git-native** — commit on keep, reset on revert
- **Ideas backlog** — log promising approaches to prevent random walk
- **Meta-prompting** — agent can create goals for itself and subagents
