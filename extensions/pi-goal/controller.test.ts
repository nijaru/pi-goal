import { describe, expect, mock, test } from "bun:test";
import { GoalController } from "./controller.ts";
import { EVENT_ENTRY, GoalStore } from "./store.ts";

function setup() {
  const branch: unknown[] = [];
  const writer = { appendEntry: (_type: string, data: unknown) => branch.push({ type: "custom", customType: EVENT_ENTRY, data }) };
  const host = { abort: mock(), sendContinuation: mock(), stateChanged: mock() };
  const store = new GoalStore(writer, "session-1", branch);
  const controller = new GoalController(store, host, () => "2026-01-01T00:00:00.000Z");
  return { controller, host };
}

describe("goal controller", () => {
  test("serializes transitions and owns continuation dispatch", async () => {
    const { controller, host } = setup();
    const goal = await controller.create({ objective: "ship", doneWhen: "tests pass", limits: { maxCost: null, maxTurns: 2, maxExecutionSeconds: null } });
    const run = await controller.startRun("user", "run-1");
    await controller.accountTurn("run-1", "turn-1", { turns: 0, inputTokens: 1, outputTokens: 2, totalTokens: 3, cost: 0.1, executionSeconds: 0 });
    await controller.accountExecution("run-1", 4);
    await controller.checkpoint("run-1", { action: "test", observation: "pass", progress: "made", evidence: "tests pass" });
    await controller.endRun("run-1");
    const dispatch = await controller.requestContinuation(false, "continue");
    expect(goal.id).toBe(run.id);
    expect(dispatch.runId).toBeString();
    expect(host.sendContinuation).toHaveBeenCalledTimes(1);
    const acknowledged = await controller.acknowledgeContinuation(dispatch.dispatchId);
    expect(acknowledged.activeRun?.owner).toBe("continuation");
  });

  test("invalidates a pending continuation when the goal revision changes", async () => {
    const { controller } = setup();
    await controller.create({ objective: "ship", doneWhen: "done", limits: { maxCost: null, maxTurns: null, maxExecutionSeconds: null } });
    const dispatch = await controller.requestContinuation(false, "continue");
    await controller.invalidateActivity("user work changed the context");
    expect(controller.state?.pendingDispatch).toBeUndefined();
    await expect(controller.acknowledgeContinuation(dispatch.dispatchId)).rejects.toThrow();
  });

  test("supersedes a continuation without blocking the goal", async () => {
    const { controller } = setup();
    await controller.create({ objective: "ship", doneWhen: "done", limits: { maxCost: null, maxTurns: null, maxExecutionSeconds: null } });
    const run = await controller.startRun("user", "run-1");
    await controller.endRun(run.activeRun!.runId);
    const dispatch = await controller.requestContinuation(false, "continue");
    const state = await controller.supersedeContinuation(dispatch.dispatchId, "user input arrived");
    expect(state.status).toBe("active");
    expect(state.pendingDispatch).toBeUndefined();
    await expect(controller.acknowledgeContinuation(dispatch.dispatchId)).rejects.toThrow();
  });

  test("replaces a cleared goal without inheriting its event sequence", async () => {
    const { controller } = setup();
    const first = await controller.create({ objective: "first", doneWhen: "done", limits: { maxCost: null, maxTurns: null, maxExecutionSeconds: null } });
    await controller.clear("replace");
    const second = await controller.create({ objective: "second", doneWhen: "done", limits: { maxCost: null, maxTurns: null, maxExecutionSeconds: null } });
    expect(second.id).not.toBe(first.id);
    expect(second.eventSeq).toBe(1);
    expect(second.objective).toBe("second");
  });

  test("prevents completion without an exact achieved evaluation", async () => {
    const { controller } = setup();
    await controller.create({ objective: "ship", doneWhen: "tests pass", limits: { maxCost: null, maxTurns: null, maxExecutionSeconds: null } });
    await expect(controller.complete()).rejects.toThrow();
    const request = await controller.requestEvaluation();
    await controller.recordEvaluation({ requestId: request.requestId, verdict: "achieved", reason: "verified", evidence: "tests pass" });
    const complete = await controller.complete();
    expect(complete.status).toBe("complete");
  });
});
