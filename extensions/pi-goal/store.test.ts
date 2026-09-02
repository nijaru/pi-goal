import { describe, expect, test } from "bun:test";
import { GoalStore, GoalStoreError, loadGoal } from "./store.ts";

const sessionId = "session-1";
const created = {
  schemaVersion: 3,
  kind: "goal_event",
  eventId: "event-1",
  seq: 1,
  sessionId,
  goalId: "goal-1",
  at: "2026-01-01T00:00:00.000Z",
  type: "created",
  objective: "ship",
};

function writer(branch: unknown[]) {
  return { appendEntry(_customType: string, data: unknown) { branch.push({ type: "custom", customType: _customType, data }); } };
}

describe("GoalStore", () => {
  test("replays the current schema and appends reducer-validated events", () => {
    const branch: unknown[] = [{ type: "custom", customType: "pi-goal/event", data: created }];
    const store = new GoalStore(writer(branch), sessionId, branch);
    expect(store.current?.objective).toBe("ship");
    const started = store.append("goal-1", "run_started", { lease: { runId: "run-1", owner: "user" } }, "2026-01-01T00:00:01.000Z");
    expect(started.activeRun?.runId).toBe("run-1");
    expect(branch).toHaveLength(2);
  });

  test("ignores the former schema instead of trying to replay it", () => {
    const old = { ...created, schemaVersion: 2, objective: "old" };
    expect(loadGoal([{ type: "custom", customType: "pi-goal/event", data: old }], sessionId).state).toBeNull();
  });

  test("rejects malformed current-schema entries", () => {
    const malformed = { ...created, objective: 42 };
    expect(() => new GoalStore(writer([]), sessionId, [{ type: "custom", customType: "pi-goal/event", data: malformed }])).toThrow(GoalStoreError);
  });

  test("snapshots and restores state", () => {
    const branch: unknown[] = [{ type: "custom", customType: "pi-goal/event", data: created }];
    const store = new GoalStore(writer(branch), sessionId, branch);
    store.snapshot("2026-01-01T00:00:02.000Z");
    expect(loadGoal(branch, sessionId).state?.objective).toBe("ship");
  });
});
