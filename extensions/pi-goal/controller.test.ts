import { describe, expect, mock, test } from "bun:test";
import { GoalController } from "./controller.ts";
import { GoalStore } from "./store.ts";

function setup() {
  const branch: unknown[] = [];
  const host = { sendContinuation: mock(), stateChanged: mock() };
  const store = new GoalStore({ appendEntry(type, data) { branch.push({ type: "custom", customType: type, data }); } }, "session-1", branch);
  const controller = new GoalController(store, host, () => "2026-01-01T00:00:00.000Z");
  return { branch, host, controller };
}

const usage = { turns: 0, inputTokens: 10, outputTokens: 5, totalTokens: 15, cost: 0.1, executionSeconds: 0 };

describe("GoalController", () => {
  test("creates, starts, accounts, and ends a run", async () => {
    const { controller } = setup();
    const created = await controller.create({ objective: "ship" });
    expect(created.status).toBe("active");
    const started = await controller.startRun("user", "run-1");
    expect(started.activeRun?.runId).toBe("run-1");
    const accounted = await controller.accountTurn("run-1", "turn-1", usage);
    expect(accounted.usage.turns).toBe(1);
    const ended = await controller.endRun("run-1");
    expect(ended?.activeRun).toBeUndefined();
  });

  test("does not replace an unfinished goal", async () => {
    const { controller } = setup();
    await controller.create({ objective: "first" });
    await expect(controller.create({ objective: "second" })).rejects.toThrow("unfinished goal");
  });

  test("allows a new goal after completion", async () => {
    const { controller } = setup();
    await controller.create({ objective: "first" });
    await controller.changeStatus("complete", "completed");
    const second = await controller.create({ objective: "second" });
    expect(second.objective).toBe("second");
    expect(second.status).toBe("active");
  });

  test("queues and acknowledges exactly one continuation", async () => {
    const { controller, host } = setup();
    await controller.create({ objective: "ship" });
    const requested = await controller.requestContinuation("Continue the goal.");
    expect(requested.dispatchId).toBeString();
    expect(host.sendContinuation).toHaveBeenCalledTimes(1);
    expect((await controller.acknowledgeContinuation(requested.dispatchId)).activeRun?.owner).toBe("continuation");
    await expect(controller.requestContinuation("another")).rejects.toThrow("active");
  });

  test("supersedes a pending continuation without an abort host", async () => {
    const { controller, host } = setup();
    await controller.create({ objective: "ship" });
    const requested = await controller.requestContinuation("Continue the goal.");
    await controller.supersedeContinuation(requested.dispatchId, "user input");
    expect((await controller.state)?.pendingDispatch).toBeUndefined();
    expect(host.sendContinuation).toHaveBeenCalledTimes(1);
  });
});
