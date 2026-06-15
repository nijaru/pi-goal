---
name: pi-goal
description: >
  Persistent loop for pi. Define what "done" means, agent works until it's done.
  Use when the user says "goal", "optimize", "iterate until", "keep working until",
  or wants to run an autonomous optimization loop.
version: 0.1.0
---

# pi-goal

Persistent loop that tries, evaluates, keeps or reverts, and repeats until done.

## Commands

- `/goal <condition>` — set a goal (natural language, metric, or test command)
- `/goal status` — show current goal
- `/goal pause` — pause the goal loop
- `/goal resume` — resume a paused goal
- `/goal clear` — clear the goal

## When to Use

- User wants to optimize something (performance, coverage, etc.)
- User wants to iterate until a condition is met
- User wants autonomous work on a long-running task
- User says "keep working until X"

## How It Works

1. Set a goal with a completion condition and budget
2. Agent makes a change each iteration
3. Adversarial evaluation (different model) checks if goal is met
4. Keep on success, revert on failure
5. Repeat until goal achieved or budget exhausted

## Key Patterns

- **Never self-evaluate** — evaluator is always a different model
- **Git-native** — commit on keep, reset on revert
- **Ideas backlog** — log promising approaches to prevent random walk
- **Plateau detection** — stop after N iterations with no improvement
