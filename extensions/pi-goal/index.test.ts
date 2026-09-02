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

const assistant = (stopReason = "stop", cost = 0.1) => ({ role: "assistant", content: [], stopReason, usage: { input: 10, output: 5, totalTokens: 15, cost: { total: cost } } });

let extension: typeof import("./index.ts").default;
beforeEach(async () => {
  vi.useFakeTimers();
  extension = (await import("./index.ts")).default;
});

describe("pi-goal supervisor", () => {
  test("keeps ordinary agent flow and only exposes create_goal without a goal", async () => {
    const pi = createMockAPI();
    extension(pi as any);
    const ctx = createMockCtx(pi.entries);
    await pi.handlers.get("before_provider_request")({ type: "before_provider_request" }, ctx);
    expect(ctx.abort).toHaveBeenCalledTimes(0);
    expect(pi.getActiveTools()).toEqual([...BUILTIN_TOOLS, "create_goal"]);
    expect(pi.tools.has("goal_checkpoint")).toBe(false);
    expect(pi.tools.has("evaluate_goal")).toBe(false);
  });

  test("creates a goal with the Codex-shaped objective-only tool", async () => {
    const pi = createMockAPI();
    extension(pi as any);
    const ctx = createMockCtx(pi.entries);
    const create = pi.tools.get("create_goal");
    expect(Object.keys(create.parameters.properties)).toEqual(["objective"]);
    const result = await create.execute("1", { objective: "ship" }, undefined, undefined, ctx);
    expect(result.details.goal.objective).toBe("ship");
    expect(result.details.goal.status).toBe("active");
    expect(pi.getActiveTools()).toEqual([...BUILTIN_TOOLS, "create_goal", "get_goal", "update_goal"]);
  });

  test("starts the user run when a goal is created during an agent cycle", async () => {
    const pi = createMockAPI();
    extension(pi as any);
    const ctx = createMockCtx(pi.entries);
    pi.handlers.get("input")({ type: "input", source: "interactive", text: "start a goal" }, ctx);
    await pi.handlers.get("agent_start")({ type: "agent_start" }, ctx);
    const result = await pi.tools.get("create_goal").execute("1", { objective: "ship" }, undefined, undefined, ctx);
    expect(result.details.goal.activeRun.owner).toBe("user");
    expect(ctx.abort).toHaveBeenCalledTimes(0);
  });

  test("does not replace an unfinished goal", async () => {
    const pi = createMockAPI();
    extension(pi as any);
    const ctx = createMockCtx(pi.entries);
    await pi.tools.get("create_goal").execute("1", { objective: "first" }, undefined, undefined, ctx);
    await expect(pi.tools.get("create_goal").execute("2", { objective: "second" }, undefined, undefined, ctx)).rejects.toThrow("unfinished goal");
  });

  test("queues one continuation after an active cycle settles", async () => {
    const pi = createMockAPI();
    extension(pi as any);
    const ctx = createMockCtx(pi.entries);
    await pi.commands.get("goal").handler("ship", ctx);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const dispatch = pi.entries.find((entry: any) => entry.data?.type === "dispatch_requested")?.data;
    expect(dispatch).toBeDefined();

    await pi.handlers.get("message_start")({ type: "message_start", message: { customType: "pi-goal/continuation", details: dispatch } }, ctx);
    await pi.handlers.get("turn_end")({ type: "turn_end", turnIndex: 0, message: assistant(), toolResults: [] }, ctx);
    await pi.handlers.get("agent_end")({ type: "agent_end", messages: [assistant()] }, ctx);
    await pi.handlers.get("agent_settled")({ type: "agent_settled" }, ctx);

    expect(pi.sendMessage).toHaveBeenCalledTimes(2);
    const events = pi.entries.filter((entry: any) => entry.customType === "pi-goal/event").map((entry: any) => entry.data.type);
    expect(events).toContain("dispatch_acknowledged");
    expect(events).toContain("run_ended");
  });

  test("does not abort user work when input supersedes a queued continuation", async () => {
    const pi = createMockAPI();
    extension(pi as any);
    const ctx = createMockCtx(pi.entries);
    await pi.commands.get("goal").handler("ship", ctx);
    const dispatch = pi.entries.find((entry: any) => entry.data?.type === "dispatch_requested")?.data;
    pi.handlers.get("input")({ type: "input", source: "interactive", text: "new direction" }, ctx);
    await pi.handlers.get("message_start")({ type: "message_start", message: { role: "user", content: [] } }, ctx);
    await pi.handlers.get("message_start")({ type: "message_start", message: { customType: "pi-goal/continuation", details: dispatch } }, ctx);
    expect(ctx.abort).toHaveBeenCalledTimes(0);
  });

  test("drains a stale continuation without aborting the provider", async () => {
    const pi = createMockAPI();
    extension(pi as any);
    const ctx = createMockCtx(pi.entries);
    await pi.commands.get("goal").handler("ship", ctx);
    const dispatch = pi.entries.find((entry: any) => entry.data?.type === "dispatch_requested")?.data;

    const reloaded = createMockAPI(pi.entries);
    extension(reloaded as any);
    const reloadedCtx = createMockCtx(reloaded.entries);
    await reloaded.handlers.get("session_start")({ type: "session_start", reason: "reload" }, reloadedCtx);
    await reloaded.handlers.get("message_start")({ type: "message_start", message: { customType: "pi-goal/continuation", details: dispatch, content: dispatch.content } }, reloadedCtx);

    expect(reloadedCtx.abort).toHaveBeenCalledTimes(0);
  });

  test("completes directly through update_goal without evaluation or checkpoints", async () => {
    const pi = createMockAPI();
    extension(pi as any);
    const ctx = createMockCtx(pi.entries);
    await pi.tools.get("create_goal").execute("1", { objective: "ship" }, undefined, undefined, ctx);
    const result = await pi.tools.get("update_goal").execute("2", { status: "complete" }, undefined, undefined, ctx);
    expect(result.terminate).toBe(true);
    expect(result.details.goal.status).toBe("complete");
    expect((await pi.tools.get("get_goal").execute("3", {}, undefined, undefined, ctx)).content[0].text).toContain("complete");
  });

  test("pauses a failed provider run without scheduling another cycle", async () => {
    const pi = createMockAPI();
    extension(pi as any);
    const ctx = createMockCtx(pi.entries);
    await pi.tools.get("create_goal").execute("1", { objective: "ship" }, undefined, undefined, ctx);
    pi.handlers.get("input")({ type: "input", source: "interactive", text: "go" }, ctx);
    await pi.handlers.get("agent_start")({ type: "agent_start" }, ctx);
    await pi.handlers.get("agent_end")({ type: "agent_end", messages: [assistant("error")] }, ctx);
    await pi.handlers.get("agent_settled")({ type: "agent_settled" }, ctx);
    const goal = (await pi.tools.get("get_goal").execute("2", {}, undefined, undefined, ctx)).details.goal;
    expect(goal.status).toBe("paused");
    expect(pi.sendMessage).toHaveBeenCalledTimes(0);
  });

  test("pause and clear release the run without aborting the host turn", async () => {
    const pi = createMockAPI();
    extension(pi as any);
    const ctx = createMockCtx(pi.entries);
    await pi.commands.get("goal").handler("ship", ctx);
    pi.handlers.get("input")({ type: "input", source: "interactive", text: "go" }, ctx);
    await pi.handlers.get("agent_start")({ type: "agent_start" }, ctx);
    await pi.commands.get("goal").handler("pause", ctx);
    expect(ctx.abort).toHaveBeenCalledTimes(0);
    expect((await pi.tools.get("get_goal").execute("2", {}, undefined, undefined, ctx)).details.goal.status).toBe("paused");
  });

  test("records usage once per provider response", async () => {
    const pi = createMockAPI();
    extension(pi as any);
    const ctx = createMockCtx(pi.entries);
    await pi.tools.get("create_goal").execute("1", { objective: "ship" }, undefined, undefined, ctx);
    pi.handlers.get("input")({ type: "input", source: "interactive", text: "go" }, ctx);
    await pi.handlers.get("agent_start")({ type: "agent_start" }, ctx);
    const message = assistant();
    await pi.handlers.get("turn_end")({ type: "turn_end", turnIndex: 0, message, toolResults: [] }, ctx);
    await pi.handlers.get("turn_end")({ type: "turn_end", turnIndex: 0, message, toolResults: [] }, ctx);
    const goal = (await pi.tools.get("get_goal").execute("2", {}, undefined, undefined, ctx)).details.goal;
    expect(goal.usage.turns).toBe(1);
    expect(goal.usage.totalTokens).toBe(15);
  });

  test("does not abort a normal no-limit cycle", async () => {
    const pi = createMockAPI();
    extension(pi as any);
    const ctx = createMockCtx(pi.entries);
    await pi.commands.get("goal").handler("ship", ctx);
    const dispatch = pi.entries.find((entry: any) => entry.data?.type === "dispatch_requested")?.data;
    await pi.handlers.get("message_start")({ type: "message_start", message: { customType: "pi-goal/continuation", details: dispatch } }, ctx);
    await pi.handlers.get("agent_end")({ type: "agent_end", messages: [assistant()] }, ctx);
    await pi.handlers.get("agent_settled")({ type: "agent_settled" }, ctx);
    expect(ctx.abort).toHaveBeenCalledTimes(0);
  });
});
