---
name: pi-goal
description: >
  Persistent loop for pi. Define what "done" means, agent works until it's done.
  Use when the user says "goal", "optimize", "iterate until", "keep working until",
  or wants to run an autonomous optimization loop.
version: 0.3.0
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
- `evaluate_goal` — optional evaluation (self or adversarial). Adversarial mode: instruct evaluator to look for gaps and failures, not confirm completeness; check generalization beyond the specific scenario; report what's missing, not just what's present. An unnecessary finding is cheaper than a missed failure.
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

- **Completion audit** — built into continuation template, agent verifies before marking complete
- **Decomposition signal** — if the cumulative diff exceeds ~1500 lines or touches >5 files, do not mark complete. Instead, decompose the remaining work into atomic tasks and log them.
- **Anti-overfitting** — completion audit must verify the solution works for the general case, not just the specific scenario that prompted it. Edge cases, different input shapes, fragile assumptions — check before marking complete.
- **Evaluator calibration** — adversarial evaluators should be instructed to find gaps, not confirm completeness. Agents systematically grade their own work too generously (NeurIPS 2024). The evaluator's job is to be skeptical by default.
- **Blocked audit** — 3 consecutive turns of same blocker before marking blocked
- **Auto-continue** — per-session limit (50 turns). Limit resets on session start and resume. Hitting the limit pauses the goal (doesn't brick it).
- **Budget-limited resumable** — goals that exhaust their budget can be resumed via `/goal resume` (unlike Codex, where budget-limited is terminal). Increase budget or clear and recreate.
- **Meta-prompting** — agent can create goals for itself and subagents
- **Git-native** — commit on keep, reset on revert
- **Ideas backlog** — log promising approaches to prevent random walk
