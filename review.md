# Review: pi-goal extension

**Scope:** `extensions/pi-goal/index.ts` + `index.test.ts`
**Date:** 2026-06-14
**Build:** 9/9 tests pass, `tsc --noEmit` clean

## Build & Tests

```
bun test v1.3.14 (0d9b296a)
  9 pass, 0 fail, 25 expect() calls
  Ran 9 tests across 1 file in 91ms
```

## Findings

### P1 — Blocked audit doesn't validate "same blocker"

index.ts:296-307 (update_goal execute, blocked path)

The design says "3 consecutive turns of **same** blocker" and `GoalState` has a `lastBlocker: string | null` field for exactly this. But `update_goal` increments `blockedCount` unconditionally on every `status: "blocked"` call without reading or writing `lastBlocker`. The field is dead code.

Worse: `UpdateGoalParams` only accepts `status`, not a blocker description. The agent has no way to report what the blocker is.

**Fix:** Add a `blocker: string` parameter to `UpdateGoalParams`. In the blocked path, compare `params.blocker` against `g.lastBlocker`. If different, reset `blockedCount` to 1 and update `g.lastBlocker`. If same, increment. This matches the Codex pattern where the same blocker must persist.

```ts
const UpdateGoalParams = Type.Object({
  status: StringEnum(["complete", "blocked"] as const, { ... }),
  blocker: Type.Optional(Type.String({ description: "Description of the blocker (required when status is 'blocked')" })),
});

// In execute, blocked path:
if (params.status === "blocked") {
  if (!params.blocker) return err("❌ blocker description required");
  if (g.lastBlocker !== params.blocker) {
    g.blockedCount = 1;
    g.lastBlocker = params.blocker;
  } else {
    g.blockedCount++;
  }
  // ... rest of threshold logic
}
```

### P1 — `readGoal` can load stale completed goal on reconstruct

index.ts:76-85

`readGoal` scans all `.pi/goal/*/state.json` directories and returns the one with the newest `updatedAt`. This doesn't filter by status. If a goal was completed 5 minutes ago and there's no active goal, `reconstruct` loads it into `rt.goal`. Then `update_goal` (which only checks `requireGoal` — "does a goal exist?") would allow marking the completed goal complete again.

**Fix:** Either filter to `status === "active" || status === "paused"` in `readGoal`, or add `requireActive` to `update_goal` (currently it only uses `requireGoal`). The latter is simpler — `update_goal` should use `requireActive`, not `requireGoal`:

```ts
// update_goal execute:
const check = requireActive(rt.goal);  // was: requireGoal
```

### P1 — `log_iteration` silently drops iterations on budget exceeded

index.ts:374-382

When `g.costUsed + params.cost > g.budget`, the status is set to `budget_limited` and the function returns early. The iteration is never recorded. The agent's work (hypothesis, result, cost) is lost. The journal never gets this entry.

If the agent calls `log_iteration` again, `requireActive` rejects because status is now `budget_limited`. So the last iteration is permanently lost.

**Fix:** Record the iteration before marking budget_limited:

```ts
// Budget check
if (g.costUsed + params.cost > g.budget) {
  // Still record the iteration (the work happened)
  const it: Iteration = {
    n: g.iterations.length + 1,
    hypothesis: params.hypothesis, result: params.result,
    cost: params.cost, status: params.status, ts: now(),
  };
  g.iterations.push(it);
  g.costUsed += params.cost;
  g.status = "budget_limited";
  g.updatedAt = now();
  save(ctx.cwd);
  cancelResume();
  updateWidget(ctx);
  try { fs.appendFileSync(goalPaths(ctx.cwd, g.id).journal, journalEntry(it)); } catch {}
  return ok(`💸 Budget exhausted ...`, { goal: g, iteration: it });
}
```

### P2 — `evaluate_goal` is self-evaluation, not adversarial

index.ts:305-340

DESIGN.md says "adversarial (different model than agent)" and AGENTS.md says "adversarial evaluation." But the tool takes `analysis`, `verdict`, and `reasoning` as **agent-provided params** and just echoes them back. The agent evaluates itself. There's no different model, no external invocation.

This is fine as structured self-reflection (the agent has to articulate its reasoning), but calling it "adversarial" is misleading. The continuation prompt's completion audit is the real adversarial mechanism (text-based, embedded in system prompt).

**Suggestion:** Either (a) rename to `reflect_on_goal` / `self_evaluate` to match what it actually does, or (b) make it truly adversarial by invoking a different model via `pi.exec` or a separate LLM call. Option (a) is simpler and honest.

### P2 — `Runtime.lastBlocker` is dead code

index.ts:61 (`rt.lastBlocker`), line 177 (reset to null), line 358 (reset to null)

`rt.lastBlocker` is initialized to `null`, reset to `null` in two places, and never read. The actual blocker tracking should live on `GoalState.lastBlocker` (which also isn't used — see P1 above). `rt.lastBlocker` serves no purpose.

**Fix:** Remove `lastBlocker` from the `Runtime` interface.

### P2 — Continuation prompt doesn't mention current blockers or ideas content

index.ts:129-170 (`buildContinuationPrompt`)

The prompt includes recent iterations but doesn't include:
1. The current `lastBlocker` text (so the agent doesn't know what it was blocked on)
2. The ideas backlog contents (so the agent might ignore logged ideas)

The ideas path is mentioned in the `before_agent_start` system prompt injection, but the agent has to make a separate tool call to read it. Including the last few ideas in the continuation prompt would reduce waste.

**Suggestion:** Add to the continuation prompt:

```ts
${g.lastBlocker ? `Current blocker: ${g.lastBlocker}\n` : ""}
${ideasContent ? `Ideas backlog:\n${ideasContent}\n` : ""}
```

### P2 — Widget icon uses emoji

index.ts:186-189

AGENTS.md style guide: "lucide/heroicons. No emoji unless requested." The widget uses `✓`, `◉`, `⊘`, `⏸` — these are Unicode symbols, not emoji, but the goal title line uses `🎯` which is emoji.

**Fix:** Replace `🎯` with a lucide icon or plain text.

### P3 — `compactionSummary` IIFE is hard to read

index.ts:442-449

The inline IIFE that reads ideas.md could be a named helper:

```ts
function readIdeas(cwd: string, id: string): string {
  try {
    const ideas = fs.readFileSync(goalPaths(cwd, id).ideas, "utf-8").trim();
    return ideas && ideas !== "# Ideas" ? `\n## Ideas\n${ideas}` : "";
  } catch { return ""; }
}
```

### P3 — `gitRevert` doesn't match DESIGN.md description

DESIGN.md says "git-native: commit on keep, reset on revert" but `gitRevert` uses `git checkout -- . && git clean -fd`, not `git reset`. The checkout approach preserves history (just discards working tree changes). `git reset --hard HEAD` would be more conventional for "revert to last commit." The current approach is actually safer (doesn't move HEAD) but doesn't match the documentation.

### P3 — Goal ID has weak collision resistance

index.ts:223

```ts
const id = now().replace(/[^0-9]/g, "").slice(-8) + Math.random().toString(36).slice(2, 6);
```

8 timestamp digits (second precision) + 4 random chars. In practice fine for single-user, but if two goals are created in the same second, the random suffix is the only differentiator (4 base-36 chars = ~1.7M possibilities). Could use `crypto.randomUUID().slice(0, 8)` for cleaner IDs.

## Missing Test Coverage

The test file covers registration, create, get, update (complete + blocked threshold), and error-on-no-goal for evaluate and log_idea. These are the happy paths. What's missing:

| Scenario | Why it matters |
|----------|---------------|
| **log_iteration happy path** (kept + reverted) | Core loop — git commit, cost tracking, journal write, iteration numbering. Zero coverage today. |
| **log_iteration budget exhaustion** | Sets `budget_limited` status, stops auto-continue. Not tested. |
| **log_iteration beforeEach/afterEach hooks** | Hooks are shell commands — need to verify they run, and that failures propagate correctly. |
| **log_iteration resets blockedCount on "kept"** | Key convergence behavior. If `blockedCount` doesn't reset, the agent blocks prematurely. |
| **blockedCount doesn't reset on repeated "blocked" calls with different blockers** | The bug in P1 — this test would catch it. |
| **/goal command** (pause, resume, clear, status) | Zero coverage for the command handler. Pause/resume is the only way to suspend a goal. |
| **reconstruct loads goals from disk** | After `session_start`, goals should persist. No test for filesystem round-trip. |
| **auto-continue lifecycle** | `agent_end` → `scheduleResume` → timeout → `sendUserMessage`. No test for the timer or MAX_AUTO_CONTINUE limit. |
| **create_goal writes journal and ideas files** | Only `state.json` is verified implicitly (via `details.goal`). Journal and ideas files are never checked. |
| **update_goal on completed goal** | Should fail ("Goal is complete"). Not tested. |
| **log_idea on completed goal** | Currently allowed (only checks `requireGoal`). Worth a test to document this is intentional. |
| **Compaction summary** | Not tested. The IIFE that reads ideas.md has a silent catch — worth verifying it doesn't crash on missing files. |

The tests use a shared import via `await import("./index.ts")` which means each test gets a fresh module but shares the same `pi` mock. The mock `exec` returns `undefined` by default, which means git operations in `log_iteration` would fail silently or throw. This is fine for the current test scope but will need a proper mock for `log_iteration` tests.

## Summary

**Fix P1s first.** The blocked audit without same-blocker validation is the most important gap — it's the core convergence mechanism from Codex, and it's broken. The `readGoal`/`update_goal` mismatch is a real bug that surfaces after session restart. The dropped iteration on budget exhaustion is a data loss edge case.

**P2s are worth fixing** before shipping — especially the dead `rt.lastBlocker` code and the misleading "adversarial" label on `evaluate_goal`.

**P3s are style/nits** — clean them up in a follow-up pass.

**Tests need significant work.** 9 tests cover registration and basic happy paths. The core loop (log_iteration) has zero coverage. The /goal command has zero coverage. Budget exhaustion, hooks, blocked audit counter behavior, and filesystem persistence are all untested.
