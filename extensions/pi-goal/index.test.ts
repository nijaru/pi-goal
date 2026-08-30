import { beforeEach, describe, expect, mock, test, vi } from "bun:test";

const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

const createMockAPI = (branch: any[] = []) => {
  const handlers = new Map<string, any>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const activeTools = new Set<string>(BUILTIN_TOOLS);
  return {
    on: mock((name: string, handler: any) => handlers.set(name, handler)),
    registerTool: mock((tool: any) => tools.set(tool.name, tool)),
    registerCommand: mock((name: string, command: any) => commands.set(name, command)),
    appendEntry: mock((customType: string, data: unknown) => branch.push({ type: "custom", customType, data })),
    sendMessage: mock(),
    setActiveTools: mock((names: string[]) => { activeTools.clear(); for (const name of names) activeTools.add(name); }),
    getActiveTools: mock(() => [...activeTools]),
    handlers,
    tools,
    commands,
    entries: branch,
    activeTools,
  };
};

const createMockCtx = (branch: any[], sessionId = "session-1") => ({
  hasUI: false,
  isIdle: mock(() => true),
  hasPendingMessages: mock(() => false),
  abort: mock(),
  ui: { notify: mock(), setWidget: mock() },
  sessionManager: { getSessionId: mock(() => sessionId), getBranch: mock(() => branch) },
});

const assistant = (cost = 0.1) => ({ role: "assistant", content: [], stopReason: "stop", usage: { input: 10, output: 5, totalTokens: 15, cost: { total: cost } } });

let extension: typeof import("./index.ts").default;
beforeEach(async () => {
  vi.useFakeTimers();
  extension = (await import("./index.ts")).default;
});

describe("pi-goal supervisor", () => {
  test("does not abort ordinary provider requests without an active goal", async () => {
    const pi = createMockAPI();
    extension(pi as any);
    const ctx = createMockCtx(pi.entries);
    await pi.handlers.get("before_provider_request")({ type: "before_provider_request", payload: {} }, ctx);
    expect(ctx.abort).toHaveBeenCalledTimes(0);
    expect(pi.getActiveTools()).toEqual([...BUILTIN_TOOLS, "create_goal"]);
  });

  test("starts a run when a goal is created during an existing provider cycle", async () => {
    const pi = createMockAPI();
    extension(pi as any);
    const ctx = createMockCtx(pi.entries);
    pi.handlers.get("input")({ type: "input", source: "interactive", text: "start a goal" }, ctx);
    await pi.handlers.get("agent_start")({ type: "agent_start" }, ctx);
    const created = await pi.tools.get("create_goal").execute("1", { objective: "ship", doneWhen: "tests pass" }, undefined, undefined, ctx);
    await pi.handlers.get("before_provider_request")({ type: "before_provider_request", payload: {} }, ctx);
    expect(created.details.goal.activeRun).toBeDefined();
    expect(ctx.abort).toHaveBeenCalledTimes(0);
    expect(pi.getActiveTools()).toEqual([...BUILTIN_TOOLS, "create_goal", "get_goal", "goal_checkpoint", "evaluate_goal", "update_goal"]);
  });

  test("continues a goal created in the first user cycle after startup", async () => {
    const pi = createMockAPI();
    extension(pi as any);
    const ctx = createMockCtx(pi.entries);
    await pi.handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
    pi.handlers.get("input")({ type: "input", source: "interactive", text: "start a goal" }, ctx);
    await pi.handlers.get("agent_start")({ type: "agent_start" }, ctx);
    await pi.handlers.get("message_start")({ type: "message_start", message: { role: "user", content: [] } }, ctx);
    await pi.tools.get("create_goal").execute("1", { objective: "ship", doneWhen: "tests pass" }, undefined, undefined, ctx);
    await pi.handlers.get("agent_end")({ type: "agent_end", messages: [assistant()] }, ctx);
    await pi.handlers.get("agent_settled")({ type: "agent_settled" }, ctx);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  test("requires an explicit definition of done", async () => {
    const pi = createMockAPI();
    extension(pi as any);
    const ctx = createMockCtx(pi.entries);
    await expect(pi.tools.get("create_goal").execute("1", { objective: "ship" }, undefined, undefined, ctx)).rejects.toThrow("doneWhen");
  });

  test("runs a checkpointed cycle and queues one continuation", async () => {
    const pi = createMockAPI();
    extension(pi as any);
    const ctx = createMockCtx(pi.entries);
    const create = await pi.tools.get("create_goal").execute("1", { objective: "ship", doneWhen: "tests pass" }, undefined, undefined, ctx);
    expect(create.details.goal.status).toBe("active");

    pi.handlers.get("input")({ type: "input", source: "interactive", text: "go" }, ctx);
    await pi.handlers.get("agent_start")({ type: "agent_start" }, ctx);
    await pi.handlers.get("message_start")({ type: "message_start", message: { role: "user", content: [] } }, ctx);
    const stateEntries = pi.entries.filter((entry: any) => entry.customType === "pi-goal/event");
    const runEvent = stateEntries.find((entry: any) => entry.data.type === "run_started");
    const activeRunId = runEvent.data.lease.runId;
    await pi.tools.get("goal_checkpoint").execute("2", { action: "run tests", observation: "tests pass", progress: "made", evidence: "bun test: pass" }, undefined, undefined, ctx);
    await pi.handlers.get("turn_end")({ type: "turn_end", turnIndex: 0, message: assistant(), toolResults: [] }, ctx);
    vi.advanceTimersByTime(1_000);
    await pi.handlers.get("agent_end")({ type: "agent_end", messages: [assistant()] }, ctx);
    expect(pi.sendMessage).toHaveBeenCalledTimes(0);
    expect((await pi.tools.get("get_goal").execute("3", {}, undefined, undefined, ctx)).details.goal.activeRun).toBeDefined();

    await pi.handlers.get("agent_settled")({ type: "agent_settled" }, ctx);
    const current = pi.entries.filter((entry: any) => entry.customType === "pi-goal/event").at(-1)?.data;
    expect(activeRunId).toBeString();
    expect(current.type).toBe("dispatch_requested");
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  test("enforces an execution-time limit with a lease-scoped deadline", async () => {
    const pi = createMockAPI();
    extension(pi as any);
    const ctx = createMockCtx(pi.entries);
    await pi.tools.get("create_goal").execute("1", { objective: "ship", doneWhen: "done", maxExecutionSeconds: 1 }, undefined, undefined, ctx);
    pi.handlers.get("input")({ type: "input", source: "interactive", text: "go" }, ctx);
    await pi.handlers.get("agent_start")({ type: "agent_start" }, ctx);
    vi.advanceTimersByTime(1_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(ctx.abort).toHaveBeenCalledTimes(1);
    expect((await pi.tools.get("get_goal").execute("2", {}, undefined, undefined, ctx)).details.goal.status).toBe("limited");
  });

  test("pauses a failed provider run without queuing more work", async () => {
    const pi = createMockAPI();
    extension(pi as any);
    const ctx = createMockCtx(pi.entries);
    await pi.tools.get("create_goal").execute("1", { objective: "ship", doneWhen: "done" }, undefined, undefined, ctx);
    pi.handlers.get("input")({ type: "input", source: "interactive", text: "go" }, ctx);
    await pi.handlers.get("agent_start")({ type: "agent_start" }, ctx);
    await pi.handlers.get("message_start")({ type: "message_start", message: { role: "user", content: [] } }, ctx);
    await pi.handlers.get("agent_end")({ type: "agent_end", messages: [{ role: "assistant", stopReason: "error" }] }, ctx);
    expect((await pi.tools.get("get_goal").execute("2", {}, undefined, undefined, ctx)).details.goal.status).toBe("active");
    await pi.handlers.get("agent_settled")({ type: "agent_settled" }, ctx);
    const state = (await pi.tools.get("get_goal").execute("3", {}, undefined, undefined, ctx)).details.goal;
    expect(state.status).toBe("paused");
    expect(pi.sendMessage).toHaveBeenCalledTimes(0);
  });

  test("retries settle the same runtime only after the final response", async () => {
    const pi = createMockAPI();
    extension(pi as any);
    const ctx = createMockCtx(pi.entries);
    await pi.tools.get("create_goal").execute("1", { objective: "ship", doneWhen: "done" }, undefined, undefined, ctx);
    pi.handlers.get("input")({ type: "input", source: "interactive", text: "go" }, ctx);
    await pi.handlers.get("agent_start")({ type: "agent_start" }, ctx);
    await pi.handlers.get("message_start")({ type: "message_start", message: { role: "user", content: [] } }, ctx);
    const first = assistant(0.1);
    const second = assistant(0.4);
    await pi.handlers.get("turn_end")({ type: "turn_end", turnIndex: 0, message: first, toolResults: [] }, ctx);
    await pi.handlers.get("agent_end")({ type: "agent_end", messages: [{ role: "assistant", stopReason: "error" }] }, ctx);
    await pi.handlers.get("agent_start")({ type: "agent_start" }, ctx);
    await pi.handlers.get("turn_end")({ type: "turn_end", turnIndex: 0, message: second, toolResults: [] }, ctx);
    await pi.handlers.get("agent_end")({ type: "agent_end", messages: [second] }, ctx);
    await pi.handlers.get("agent_settled")({ type: "agent_settled" }, ctx);
    const state = (await pi.tools.get("get_goal").execute("2", {}, undefined, undefined, ctx)).details.goal;
    expect(state.status).toBe("active");
    expect(state.usage.turns).toBe(2);
    expect(state.usage.cost).toBeCloseTo(0.5);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  test("replacement aborts the old run instead of rebinding it", async () => {
    const pi = createMockAPI();
    extension(pi as any);
    const ctx = createMockCtx(pi.entries);
    await pi.tools.get("create_goal").execute("1", { objective: "first", doneWhen: "done" }, undefined, undefined, ctx);
    pi.handlers.get("input")({ type: "input", source: "interactive", text: "go" }, ctx);
    await pi.handlers.get("agent_start")({ type: "agent_start" }, ctx);
    await pi.handlers.get("message_start")({ type: "message_start", message: { role: "user", content: [] } }, ctx);
    await pi.tools.get("create_goal").execute("2", { objective: "second", doneWhen: "done" }, undefined, undefined, ctx);
    expect(ctx.abort).toHaveBeenCalledTimes(1);
    expect((await pi.tools.get("get_goal").execute("3", {}, undefined, undefined, ctx)).details.goal.objective).toBe("second");
  });

  test("rejects a stale continuation and accepts fresh evaluation evidence", async () => {
    const pi = createMockAPI();
    extension(pi as any);
    const ctx = createMockCtx(pi.entries);
    await pi.tools.get("create_goal").execute("1", { objective: "ship", doneWhen: "tests pass" }, undefined, undefined, ctx);
    const request = await pi.tools.get("evaluate_goal").execute("2", {}, undefined, undefined, ctx);
    await expect(pi.tools.get("evaluate_goal").execute("3", { requestId: request.details.requestId, verdict: "achieved", reason: "yes", evidence: "tests pass" }, undefined, undefined, ctx)).resolves.toBeDefined();
    const complete = await pi.tools.get("update_goal").execute("4", { status: "complete" }, undefined, undefined, ctx);
    expect(complete.details.goal.status).toBe("complete");
  });

  test("preserves a pending evaluation through successful read-only inspection", async () => {
    const pi = createMockAPI();
    extension(pi as any);
    const ctx = createMockCtx(pi.entries);
    await pi.tools.get("create_goal").execute("1", { objective: "ship", doneWhen: "tests pass" }, undefined, undefined, ctx);
    const request = await pi.tools.get("evaluate_goal").execute("2", {}, undefined, undefined, ctx);
    pi.handlers.get("tool_execution_end")({ type: "tool_execution_end", toolName: "read", isError: false }, ctx);
    await expect(pi.tools.get("evaluate_goal").execute("3", { requestId: request.details.requestId, verdict: "achieved", reason: "yes", evidence: "tests pass" }, undefined, undefined, ctx)).resolves.toBeDefined();
  });

  test("invalidates a pending evaluation after successful mutation", async () => {
    const pi = createMockAPI();
    extension(pi as any);
    const ctx = createMockCtx(pi.entries);
    await pi.tools.get("create_goal").execute("1", { objective: "ship", doneWhen: "tests pass" }, undefined, undefined, ctx);
    const request = await pi.tools.get("evaluate_goal").execute("2", {}, undefined, undefined, ctx);
    pi.handlers.get("tool_execution_end")({ type: "tool_execution_end", toolName: "write", isError: false }, ctx);
    await Promise.resolve();
    await expect(pi.tools.get("evaluate_goal").execute("3", { requestId: request.details.requestId, verdict: "achieved", reason: "yes", evidence: "tests pass" }, undefined, undefined, ctx)).rejects.toThrow("stale");
  });

  test("invalidates a pending evaluation after a failed mutation", async () => {
    const pi = createMockAPI();
    extension(pi as any);
    const ctx = createMockCtx(pi.entries);
    await pi.tools.get("create_goal").execute("1", { objective: "ship", doneWhen: "tests pass" }, undefined, undefined, ctx);
    const request = await pi.tools.get("evaluate_goal").execute("2", {}, undefined, undefined, ctx);
    pi.handlers.get("tool_execution_end")({ type: "tool_execution_end", toolName: "write", isError: true }, ctx);
    await Promise.resolve();
    await expect(pi.tools.get("evaluate_goal").execute("3", { requestId: request.details.requestId, verdict: "achieved", reason: "yes", evidence: "tests pass" }, undefined, undefined, ctx)).rejects.toThrow("stale");
  });

  test("keeps the active lease through automatic compaction", async () => {
    const pi = createMockAPI();
    extension(pi as any);
    const ctx = createMockCtx(pi.entries);
    await pi.tools.get("create_goal").execute("1", { objective: "ship", doneWhen: "done" }, undefined, undefined, ctx);
    pi.handlers.get("input")({ type: "input", source: "interactive", text: "go" }, ctx);
    await pi.handlers.get("agent_start")({ type: "agent_start" }, ctx);
    await pi.handlers.get("message_start")({ type: "message_start", message: { role: "user", content: [] } }, ctx);
    const before = (await pi.tools.get("get_goal").execute("2", {}, undefined, undefined, ctx)).details.goal.activeRun.runId;
    await pi.handlers.get("session_before_compact")({ type: "session_before_compact", reason: "overflow", willRetry: true }, ctx);
    const after = (await pi.tools.get("get_goal").execute("3", {}, undefined, undefined, ctx)).details.goal;
    expect(after.status).toBe("active");
    expect(after.activeRun.runId).toBe(before);
    await pi.handlers.get("session_compact")({ type: "session_compact", compactionEntry: {} }, ctx);
    expect(pi.sendMessage).toHaveBeenCalledTimes(0);
  });

  test("commands admit goal work after startup", async () => {
    const pi = createMockAPI();
    extension(pi as any);
    const ctx = createMockCtx(pi.entries);
    await pi.handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
    await pi.commands.get("goal").handler("ship", ctx);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  test("blocks an unacknowledged continuation after its timeout", async () => {
    const pi = createMockAPI();
    extension(pi as any);
    const ctx = createMockCtx(pi.entries);
    await pi.commands.get("goal").handler("ship", ctx);
    vi.advanceTimersByTime(30_000);
    await Promise.resolve();
    await Promise.resolve();
    expect((await pi.tools.get("get_goal").execute("2", {}, undefined, undefined, ctx)).details.goal.status).toBe("blocked");
  });

  test("manual compaction recovers a run that settled before the hook", async () => {
    const pi = createMockAPI();
    extension(pi as any);
    const ctx = createMockCtx(pi.entries);
    await pi.tools.get("create_goal").execute("1", { objective: "ship", doneWhen: "done" }, undefined, undefined, ctx);
    pi.handlers.get("input")({ type: "input", source: "interactive", text: "go" }, ctx);
    await pi.handlers.get("agent_start")({ type: "agent_start" }, ctx);
    await pi.handlers.get("message_start")({ type: "message_start", message: { role: "user", content: [] } }, ctx);
    await pi.handlers.get("agent_end")({ type: "agent_end", messages: [{ role: "assistant", stopReason: "aborted" }] }, ctx);
    await pi.handlers.get("agent_settled")({ type: "agent_settled" }, ctx);
    expect((await pi.tools.get("get_goal").execute("2", {}, undefined, undefined, ctx)).details.goal.status).toBe("paused");
    await pi.handlers.get("session_before_compact")({ type: "session_before_compact", reason: "manual", willRetry: false }, ctx);
    await pi.handlers.get("session_compact")({ type: "session_compact", compactionEntry: {} }, ctx);
    expect((await pi.tools.get("get_goal").execute("3", {}, undefined, undefined, ctx)).details.goal.status).toBe("active");
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  test("manual compaction resumes an active goal after success", async () => {
    const pi = createMockAPI();
    extension(pi as any);
    const ctx = createMockCtx(pi.entries);
    await pi.commands.get("goal").handler("ship", ctx);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    await pi.handlers.get("session_before_compact")({ type: "session_before_compact", reason: "manual", willRetry: false }, ctx);
    expect((await pi.tools.get("get_goal").execute("2", {}, undefined, undefined, ctx)).details.goal.status).toBe("paused");
    await pi.handlers.get("session_compact")({ type: "session_compact", compactionEntry: {} }, ctx);
    expect((await pi.tools.get("get_goal").execute("3", {}, undefined, undefined, ctx)).details.goal.status).toBe("active");
    expect(pi.sendMessage).toHaveBeenCalledTimes(2);
  });

  test("compaction failure clears a pending continuation", async () => {
    const pi = createMockAPI();
    extension(pi as any);
    const ctx = createMockCtx(pi.entries);
    await pi.commands.get("goal").handler("ship", ctx);
    await pi.handlers.get("session_compact_failed")({ type: "session_compact_failed", reason: "manual", aborted: true, willRetry: false, fromExtension: false }, ctx);
    expect((await pi.tools.get("get_goal").execute("2", {}, undefined, undefined, ctx)).details.goal.pendingDispatch).toBeUndefined();
  });

  test("restart makes an interrupted active run resumable", async () => {
    const pi = createMockAPI();
    extension(pi as any);
    const ctx = createMockCtx(pi.entries);
    await pi.tools.get("create_goal").execute("1", { objective: "ship", doneWhen: "done" }, undefined, undefined, ctx);
    pi.handlers.get("input")({ type: "input", source: "interactive", text: "go" }, ctx);
    await pi.handlers.get("agent_start")({ type: "agent_start" }, ctx);
    await pi.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "reload" }, ctx);
    const replacement = createMockAPI(pi.entries);
    extension(replacement as any);
    const replacementCtx = createMockCtx(replacement.entries);
    await replacement.handlers.get("session_start")({ type: "session_start", reason: "reload" }, replacementCtx);
    const state = (await replacement.tools.get("get_goal").execute("2", {}, undefined, undefined, replacementCtx)).details.goal;
    expect(state.status).toBe("paused");
    expect(state.activeRun).toBeUndefined();
  });

  test("restart cancels an unacknowledged continuation", async () => {
    const pi = createMockAPI();
    extension(pi as any);
    const ctx = createMockCtx(pi.entries);
    await pi.commands.get("goal").handler("ship", ctx);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const replacement = createMockAPI(pi.entries);
    extension(replacement as any);
    const replacementCtx = createMockCtx(replacement.entries);
    await replacement.handlers.get("session_start")({ type: "session_start", reason: "reload" }, replacementCtx);
    await Promise.resolve();
    expect((await replacement.tools.get("get_goal").execute("2", {}, undefined, undefined, replacementCtx)).details.goal.pendingDispatch).toBeUndefined();
  });

  test("invalidates an evaluation when user steering arrives", async () => {
    const pi = createMockAPI();
    extension(pi as any);
    const ctx = createMockCtx(pi.entries);
    const created = await pi.tools.get("create_goal").execute("1", { objective: "ship", doneWhen: "done" }, undefined, undefined, ctx);
    const request = await pi.tools.get("evaluate_goal").execute("2", {}, undefined, undefined, ctx);
    expect(created.details.goal.revision).toBe(0);
    expect(request.details.goal.evaluation.requestId).toBe(request.details.requestId);
    pi.handlers.get("input")({ type: "input", source: "interactive", text: "new direction" }, ctx);
    await Promise.resolve();
    await Promise.resolve();
    const state = (await pi.tools.get("get_goal").execute("3", {}, undefined, undefined, ctx)).details.goal;
    expect(state.evaluation).toBeUndefined();
    expect(state.revision).toBe(1);
  });

  test("reconstructs only the new event schema", async () => {
    const pi = createMockAPI();
    extension(pi as any);
    const ctx = createMockCtx(pi.entries);
    await pi.tools.get("create_goal").execute("1", { objective: "new", doneWhen: "done" }, undefined, undefined, ctx);
    const replacement = createMockAPI(pi.entries);
    extension(replacement as any);
    const replacementCtx = createMockCtx(replacement.entries);
    await replacement.handlers.get("session_start")({ type: "session_start", reason: "startup" }, replacementCtx);
    expect((await replacement.tools.get("get_goal").execute("2", {}, undefined, undefined, replacementCtx)).details.goal.objective).toBe("new");
  });
});
