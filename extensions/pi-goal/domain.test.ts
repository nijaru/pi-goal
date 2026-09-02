import { describe, expect, test } from "bun:test";
import { GoalTransitionError, reduceGoal } from "./domain.ts";
import type { GoalEvent, GoalState } from "./domain.ts";

const base = { id: "goal-1", sessionId: "session-1", objective: "ship it", at: "2026-01-01T00:00:00.000Z" };

function event(seq: number, type: GoalEvent["type"], payload: Record<string, unknown>): GoalEvent {
  return { schemaVersion: 3, kind: "goal_event", eventId: `event-${seq}`, seq, sessionId: base.sessionId, goalId: base.id, at: base.at, type, ...payload } as GoalEvent;
}

function running(): { state: GoalState; runId: string } {
  const created = reduceGoal(null, event(1, "created", { objective: base.objective }))!;
  const state = reduceGoal(created, event(2, "run_started", { lease: { runId: "run-1", owner: "user" } }))!;
  return { state, runId: "run-1" };
}

describe("pi-goal domain", () => {
  test("creates a goal and accounts a provider turn once", () => {
    const { state, runId } = running();
    const accounted = reduceGoal(state, event(3, "turn_accounted", { runId, turnId: "turn-1", inputTokens: 10, outputTokens: 5, totalTokens: 15, cost: 0.1 }))!;
    expect(accounted.status).toBe("active");
    expect(accounted.usage).toEqual({ turns: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15, cost: 0.1, executionSeconds: 0 });
    expect(accounted.accountedTurnIds).toEqual(["turn-1"]);
  });

  test("supports pause, resume, completion, and blocked terminal states", () => {
    const { state } = running();
    const paused = reduceGoal(state, event(3, "status_changed", { status: "paused", reason: "paused by user" }))!;
    expect(paused.activeRun).toBeUndefined();
    const resumed = reduceGoal(paused, event(4, "status_changed", { status: "active", reason: "resumed by user" }))!;
    const complete = reduceGoal(resumed, event(5, "status_changed", { status: "complete", reason: "completed by model" }))!;
    expect(complete.status).toBe("complete");
    expect(complete.activeRun).toBeUndefined();
    expect(() => reduceGoal(complete, event(6, "status_changed", { status: "blocked", reason: "blocked" }))).toThrow(GoalTransitionError);
  });

  test("rejects stale run and dispatch events", () => {
    const { state, runId } = running();
    expect(() => reduceGoal(state, event(3, "turn_accounted", { runId: "other", turnId: "turn-1", inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 }))).toThrow("Stale");
    const pending = reduceGoal(state, event(3, "dispatch_requested", { dispatchId: "dispatch-1", runId: "run-2" }))!;
    expect(pending.pendingDispatch).toEqual({ dispatchId: "dispatch-1", runId: "run-2" });
    const acknowledged = reduceGoal(pending, event(4, "dispatch_acknowledged", { dispatchId: "dispatch-1" }))!;
    expect(acknowledged.pendingDispatch).toBeUndefined();
  });

  test("does not allow creating an empty objective", () => {
    expect(() => reduceGoal(null, event(1, "created", { objective: " " }))).toThrow("Objective");
  });
});
