import { describe, expect, test } from "bun:test";
import { canComplete, createGoalState, reduceGoal, GoalTransitionError } from "./domain.ts";
import type { GoalEvent, GoalState } from "./domain.ts";

const base = { id: "goal-1", sessionId: "session-1", objective: "ship it", doneWhen: "tests pass", limits: { maxCost: null, maxTurns: 3, maxExecutionSeconds: null }, at: "2026-01-01T00:00:00.000Z" };
const event = <T extends GoalEvent["type"]>(seq: number, type: T, payload: Record<string, unknown>): GoalEvent => ({ schemaVersion: 2, kind: "goal_event", eventId: `event-${seq}`, seq, sessionId: base.sessionId, goalId: base.id, at: `2026-01-01T00:00:0${seq}.000Z`, type, ...payload } as unknown as GoalEvent);

function running(): { state: GoalState; runId: string } {
  const created = event(1, "created", { objective: base.objective, doneWhen: base.doneWhen, limits: base.limits });
  const state = reduceGoal(null, created)!;
  return { state: reduceGoal(state, event(2, "run_started", { lease: { runId: "run-1", owner: "user", goalRevision: 0 } }))!, runId: "run-1" };
}

describe("goal reducer", () => {
  test("models progress, usage, and hard limits", () => {
    const { state, runId } = running();
    const used = reduceGoal(state, event(3, "turn_accounted", { runId, turnId: "run-1:0", inputTokens: 2, outputTokens: 3, totalTokens: 5, cost: 0.1 }))!;
    expect(used.usage.turns).toBe(1);
    expect(used.usage.totalTokens).toBe(5);
    const limited = reduceGoal(used, event(4, "execution_accounted", { runId, seconds: 2 }))!;
    expect(limited.status).toBe("active");
    const next = reduceGoal(limited, event(5, "checkpointed", { checkpoint: { runId, action: "run tests", observation: "pass", progress: "made", evidence: "3 tests pass" } }))!;
    expect(next.progress.checkpoints).toHaveLength(1);
    expect(next.progress.consecutiveNoProgress).toBe(0);
  });

  test("rejects stale run leases and completion without evidence", () => {
    const { state } = running();
    expect(() => reduceGoal(state, event(3, "turn_accounted", { runId: "stale", turnId: "stale:0", inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 }))).toThrow(GoalTransitionError);
    expect(canComplete(state)).toBe(false);
  });

  test("enforces the completion gate in the reducer itself", () => {
    const { state } = running();
    expect(() => reduceGoal(state, event(3, "status_changed", { status: "complete", reason: "forged" }))).toThrow(GoalTransitionError);
  });

  test("applies execution-time limits independently of turn usage", () => {
    const { state, runId } = running();
    const limited = reduceGoal(state, event(3, "execution_accounted", { runId, seconds: 1 }))!;
    expect(limited.status).toBe("active");
    const eventWithLimit = { ...event(4, "execution_accounted", { runId, seconds: 1 }), goalId: limited.id };
    limited.limits.maxExecutionSeconds = 1;
    expect(reduceGoal(limited, eventWithLimit)!.status).toBe("limited");
  });

  test("blocks repeated no-progress checkpoints", () => {
    let { state, runId } = running();
    for (let seq = 3; seq <= 5; seq++) {
      state = reduceGoal(state, event(seq, "checkpointed", { checkpoint: { runId, action: "repeat", observation: "same failure", progress: "none", evidence: "failure" } }))!;
    }
    expect(state.status).toBe("blocked");
    expect(state.blocker).toContain("same failure");
  });

  test("invalidates an evaluation when activity changes", () => {
    let { state, runId } = running();
    state = reduceGoal(state, event(3, "run_ended", { runId }))!;
    state = reduceGoal(state, event(4, "evaluation_requested", { requestId: "request-1", revision: state.revision, activityEpoch: state.activityEpoch }))!;
    state = reduceGoal(state, event(5, "activity_invalidated", { reason: "file changed" }))!;
    expect(state.evaluation).toBeUndefined();
  });
});
