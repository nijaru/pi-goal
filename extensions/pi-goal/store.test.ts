import { describe, expect, test } from "bun:test";
import { EVENT_ENTRY, GoalStore, GoalStoreError, loadGoal } from "./store.ts";

const base = { schemaVersion: 2, kind: "goal_event", sessionId: "session-1", goalId: "goal-1", at: "2026-01-01T00:00:00.000Z" };
const created = { ...base, eventId: "event-1", seq: 1, type: "created", objective: "ship", doneWhen: "tests pass", limits: { maxCost: null, maxTurns: null, maxExecutionSeconds: null } };

function writer(branch: unknown[]) {
  return { appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }) };
}

describe("goal event store", () => {
  test("replays branch events and appends new events", () => {
    const branch: unknown[] = [{ type: "custom", customType: EVENT_ENTRY, data: created }];
    const store = new GoalStore(writer(branch), "session-1", branch);
    expect(store.current?.objective).toBe("ship");
    const state = store.append("goal-1", "activity_invalidated", { reason: "test" }, "2026-01-01T00:00:01.000Z");
    expect(state.revision).toBe(1);
    expect(branch).toHaveLength(2);
  });

  test("replays a compact snapshot followed by later events", () => {
    const branch: unknown[] = [{ type: "custom", customType: EVENT_ENTRY, data: created }];
    const store = new GoalStore(writer(branch), "session-1", branch);
    store.append("goal-1", "activity_invalidated", { reason: "before compact" }, "2026-01-01T00:00:01.000Z");
    store.snapshot("2026-01-01T00:00:02.000Z");
    store.append("goal-1", "activity_invalidated", { reason: "after compact" }, "2026-01-01T00:00:03.000Z");
    const replayed = loadGoal(branch, "session-1").state!;
    expect(replayed.revision).toBe(2);
    expect(replayed.eventSeq).toBe(3);
  });

  test("rejects a persisted completion without evaluation evidence", () => {
    const forged = { ...base, eventId: "event-2", seq: 2, type: "status_changed", status: "complete", reason: "forged" };
    expect(() => loadGoal([{ type: "custom", customType: EVENT_ENTRY, data: created }, { type: "custom", customType: EVENT_ENTRY, data: forged }], "session-1")).toThrow(GoalStoreError);
  });

  test("ignores duplicate event IDs but rejects malformed events", () => {
    const duplicateBranch = [
      { type: "custom", customType: EVENT_ENTRY, data: created },
      { type: "custom", customType: EVENT_ENTRY, data: created },
    ];
    expect(loadGoal(duplicateBranch, "session-1").state?.objective).toBe("ship");
    expect(() => loadGoal([{ type: "custom", customType: EVENT_ENTRY, data: { ...created, seq: 0 } }], "session-1")).toThrow(GoalStoreError);
  });
});
