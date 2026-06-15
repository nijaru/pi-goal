/**
 * pi-goal extension tests
 */
import { describe, test, expect, mock } from "bun:test";

const createMockAPI = () => {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, any>();

  return {
    registerTool: mock((tool: any) => tools.set(tool.name, tool)),
    registerCommand: mock((name: string, cmd: any) => commands.set(name, cmd)),
    on: mock((event: string, handler: any) => handlers.set(event, handler)),
    sendUserMessage: mock(),
    exec: mock(),
    getActiveTools: mock(() => []),
    setActiveTools: mock(),
    getTool: (name: string) => tools.get(name),
    getCommand: (name: string) => commands.get(name),
    tools, commands, handlers,
  };
};

const createMockCtx = (cwd = "/tmp/test-goal") => ({
  cwd, hasUI: false,
  isIdle: mock(() => true),
  hasPendingMessages: mock(() => false),
  ui: { notify: mock(), setWidget: mock() },
  sessionManager: { getSessionId: mock(() => "test"), getBranch: mock(() => []) },
  abort: mock(),
});

describe("pi-goal extension", () => {
  test("exports a function", async () => {
    const mod = await import("./index.ts");
    expect(typeof mod.default).toBe("function");
  });

  test("registers expected tools and commands", async () => {
    const mod = await import("./index.ts");
    const pi = createMockAPI();
    mod.default(pi as any);

    expect(pi.registerTool).toHaveBeenCalledTimes(6);
    expect(pi.tools.has("create_goal")).toBe(true);
    expect(pi.tools.has("get_goal")).toBe(true);
    expect(pi.tools.has("update_goal")).toBe(true);
    expect(pi.tools.has("evaluate_goal")).toBe(true);
    expect(pi.tools.has("log_iteration")).toBe(true);
    expect(pi.tools.has("log_idea")).toBe(true);

    expect(pi.registerCommand).toHaveBeenCalledTimes(1);
    expect(pi.commands.has("goal")).toBe(true);
  });

  test("create_goal creates goal state", async () => {
    const mod = await import("./index.ts");
    const pi = createMockAPI();
    mod.default(pi as any);

    const createGoal = pi.getTool("create_goal");
    const ctx = createMockCtx();
    const result = await createGoal.execute("c1", { objective: "all tests pass", budget: 5 }, undefined, undefined, ctx);

    expect(result.content[0].text).toContain("Goal created");
    expect(result.details.goal).toBeDefined();
    expect(result.details.goal.objective).toBe("all tests pass");
    expect(result.details.goal.status).toBe("active");
  });

  test("create_goal rejects empty objective", async () => {
    const mod = await import("./index.ts");
    const pi = createMockAPI();
    mod.default(pi as any);

    const createGoal = pi.getTool("create_goal");
    const ctx = createMockCtx();
    const result = await createGoal.execute("c1", { objective: "  ", budget: 5 }, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("Objective is required");
  });

  test("create_goal rejects non-positive budget", async () => {
    const mod = await import("./index.ts");
    const pi = createMockAPI();
    mod.default(pi as any);

    const createGoal = pi.getTool("create_goal");
    const ctx = createMockCtx();
    const result = await createGoal.execute("c1", { objective: "test", budget: 0 }, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("Budget must be positive");
  });

  test("create_goal rejects if active goal exists", async () => {
    const mod = await import("./index.ts");
    const pi = createMockAPI();
    mod.default(pi as any);

    const createGoal = pi.getTool("create_goal");
    const ctx = createMockCtx();
    await createGoal.execute("c1", { objective: "first goal", budget: 5 }, undefined, undefined, ctx);
    const result = await createGoal.execute("c2", { objective: "second goal", budget: 3 }, undefined, undefined, ctx);

    expect(result.content[0].text).toContain("Active goal exists");
  });

  test("get_goal returns state", async () => {
    const mod = await import("./index.ts");
    const pi = createMockAPI();
    mod.default(pi as any);

    const createGoal = pi.getTool("create_goal");
    const getGoal = pi.getTool("get_goal");
    const ctx = createMockCtx();
    await createGoal.execute("c1", { objective: "test objective", budget: 5 }, undefined, undefined, ctx);
    const result = await getGoal.execute("c2", {}, undefined, undefined, ctx);

    expect(result.content[0].text).toContain("test objective");
    expect(result.content[0].text).toContain("active");
  });

  test("update_goal marks complete", async () => {
    const mod = await import("./index.ts");
    const pi = createMockAPI();
    mod.default(pi as any);

    const createGoal = pi.getTool("create_goal");
    const updateGoal = pi.getTool("update_goal");
    const ctx = createMockCtx();
    await createGoal.execute("c1", { objective: "test", budget: 5 }, undefined, undefined, ctx);
    const result = await updateGoal.execute("c2", { status: "complete" }, undefined, undefined, ctx);

    expect(result.content[0].text).toContain("Goal complete");
    expect(result.details.goal.status).toBe("complete");
  });

  test("update_goal blocks after threshold with same blocker", async () => {
    const mod = await import("./index.ts");
    const pi = createMockAPI();
    mod.default(pi as any);

    const createGoal = pi.getTool("create_goal");
    const updateGoal = pi.getTool("update_goal");
    const ctx = createMockCtx();
    await createGoal.execute("c1", { objective: "test", budget: 5 }, undefined, undefined, ctx);

    // Same blocker three times
    const r1 = await updateGoal.execute("c2", { status: "blocked", blocker: "missing API key" }, undefined, undefined, ctx);
    expect(r1.content[0].text).toContain("Blocker noted");

    const r2 = await updateGoal.execute("c3", { status: "blocked", blocker: "missing API key" }, undefined, undefined, ctx);
    expect(r2.content[0].text).toContain("Blocker noted");

    const r3 = await updateGoal.execute("c4", { status: "blocked", blocker: "missing API key" }, undefined, undefined, ctx);
    expect(r3.content[0].text).toContain("Goal blocked");
    expect(r3.details.goal.status).toBe("blocked");
  });

  test("update_goal resets blocked count on different blocker", async () => {
    const mod = await import("./index.ts");
    const pi = createMockAPI();
    mod.default(pi as any);

    const createGoal = pi.getTool("create_goal");
    const updateGoal = pi.getTool("update_goal");
    const ctx = createMockCtx();
    await createGoal.execute("c1", { objective: "test", budget: 5 }, undefined, undefined, ctx);

    // Two of blocker A
    await updateGoal.execute("c2", { status: "blocked", blocker: "blocker A" }, undefined, undefined, ctx);
    await updateGoal.execute("c3", { status: "blocked", blocker: "blocker A" }, undefined, undefined, ctx);

    // Different blocker resets count
    const r = await updateGoal.execute("c4", { status: "blocked", blocker: "blocker B" }, undefined, undefined, ctx);
    expect(r.content[0].text).toContain("1/3");
  });

  test("update_goal requires blocker description", async () => {
    const mod = await import("./index.ts");
    const pi = createMockAPI();
    mod.default(pi as any);

    const createGoal = pi.getTool("create_goal");
    const updateGoal = pi.getTool("update_goal");
    const ctx = createMockCtx();
    await createGoal.execute("c1", { objective: "test", budget: 5 }, undefined, undefined, ctx);

    const r = await updateGoal.execute("c2", { status: "blocked" }, undefined, undefined, ctx);
    expect(r.content[0].text).toContain("blocker description required");
  });

  test("update_goal uses requireActive (rejects completed goal)", async () => {
    const mod = await import("./index.ts");
    const pi = createMockAPI();
    mod.default(pi as any);

    const createGoal = pi.getTool("create_goal");
    const updateGoal = pi.getTool("update_goal");
    const ctx = createMockCtx();
    await createGoal.execute("c1", { objective: "test", budget: 5 }, undefined, undefined, ctx);
    await updateGoal.execute("c2", { status: "complete" }, undefined, undefined, ctx);
    const r = await updateGoal.execute("c3", { status: "complete" }, undefined, undefined, ctx);
    expect(r.content[0].text).toContain("Goal is complete");
  });

  test("update_goal pauses goal", async () => {
    const mod = await import("./index.ts");
    const pi = createMockAPI();
    mod.default(pi as any);

    const createGoal = pi.getTool("create_goal");
    const updateGoal = pi.getTool("update_goal");
    const getGoal = pi.getTool("get_goal");
    const ctx = createMockCtx();
    await createGoal.execute("c1", { objective: "test", budget: 5 }, undefined, undefined, ctx);
    const r = await updateGoal.execute("c2", { status: "paused" }, undefined, undefined, ctx);
    expect(r.content[0].text).toContain("Goal paused");

    const state = await getGoal.execute("c3", {}, undefined, undefined, ctx);
    expect(state.content[0].text).toContain("paused");
  });

  test("update_goal clears goal", async () => {
    const mod = await import("./index.ts");
    const pi = createMockAPI();
    mod.default(pi as any);

    const createGoal = pi.getTool("create_goal");
    const updateGoal = pi.getTool("update_goal");
    const getGoal = pi.getTool("get_goal");
    const ctx = createMockCtx();
    await createGoal.execute("c1", { objective: "test", budget: 5 }, undefined, undefined, ctx);
    const r = await updateGoal.execute("c2", { status: "cleared" }, undefined, undefined, ctx);
    expect(r.content[0].text).toContain("Goal cleared");

    const state = await getGoal.execute("c3", {}, undefined, undefined, ctx);
    expect(state.content[0].text).toContain("No active goal");
  });

  test("update_goal cleared works when no goal", async () => {
    const mod = await import("./index.ts");
    const pi = createMockAPI();
    mod.default(pi as any);

    const updateGoal = pi.getTool("update_goal");
    const ctx = createMockCtx();
    const r = await updateGoal.execute("c1", { status: "cleared" }, undefined, undefined, ctx);
    expect(r.content[0].text).toContain("No goal to clear");
  });

  test("evaluate_goal returns error when no goal", async () => {
    const mod = await import("./index.ts");
    const pi = createMockAPI();
    mod.default(pi as any);

    const evaluateGoal = pi.getTool("evaluate_goal");
    const ctx = createMockCtx();
    const result = await evaluateGoal.execute("c1", { analysis: "test", verdict: "not_yet", reasoning: "test" }, undefined, undefined, ctx);

    expect(result.content[0].text).toContain("No active goal");
  });

  test("evaluate_goal self mode returns verdict", async () => {
    const mod = await import("./index.ts");
    const pi = createMockAPI();
    mod.default(pi as any);

    const createGoal = pi.getTool("create_goal");
    const evaluateGoal = pi.getTool("evaluate_goal");
    const ctx = createMockCtx();
    await createGoal.execute("c1", { objective: "tests pass", budget: 5 }, undefined, undefined, ctx);

    const r = await evaluateGoal.execute("c2", { mode: "self", analysis: "All tests pass", verdict: "achieved", reasoning: "Verified via bun test" }, undefined, undefined, ctx);
    expect(r.content[0].text).toContain("achieved");
    expect(r.content[0].text).toContain("update_goal with status 'complete'");
  });

  test("evaluate_goal adversarial returns prompt for subagent", async () => {
    const mod = await import("./index.ts");
    const pi = createMockAPI();
    mod.default(pi as any);

    const createGoal = pi.getTool("create_goal");
    const evaluateGoal = pi.getTool("evaluate_goal");
    const ctx = createMockCtx();
    await createGoal.execute("c1", { objective: "tests pass", budget: 5 }, undefined, undefined, ctx);

    const r = await evaluateGoal.execute("c2", { mode: "adversarial" }, undefined, undefined, ctx);
    expect(r.content[0].text).toContain("subagent");
    expect(r.content[0].text).toContain("followUp");
    expect(r.content[0].text).toContain("tests pass");
    expect(r.details.mode).toBe("adversarial");
  });

  test("before_agent_start auto-clears terminal goal after threshold", async () => {
    const mod = await import("./index.ts");
    const pi = createMockAPI();
    mod.default(pi as any);

    const createGoal = pi.getTool("create_goal");
    const updateGoal = pi.getTool("update_goal");
    const ctx = createMockCtx();
    ctx.hasUI = true;
    await createGoal.execute("c1", { objective: "test", budget: 5 }, undefined, undefined, ctx);
    await updateGoal.execute("c2", { status: "complete" }, undefined, undefined, ctx);

    // Reset mock to clear calls from setup
    ctx.ui.setWidget.mockClear();

    const handler = pi.handlers.get("before_agent_start");
    // Simulate TERMINAL_TURNS (3) agent starts
    handler({ systemPrompt: "" }, ctx);
    handler({ systemPrompt: "" }, ctx);
    expect(ctx.ui.setWidget).not.toHaveBeenCalled();

    handler({ systemPrompt: "" }, ctx);
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("goal", undefined);
  });

  test("log_idea returns error when no goal", async () => {
    const mod = await import("./index.ts");
    const pi = createMockAPI();
    mod.default(pi as any);

    const logIdea = pi.getTool("log_idea");
    const ctx = createMockCtx();
    const result = await logIdea.execute("c1", { idea: "try something" }, undefined, undefined, ctx);

    expect(result.content[0].text).toContain("No active goal");
  });

  // --- log_iteration ---

  test("log_iteration records iteration and updates goal", async () => {
    const mod = await import("./index.ts");
    const pi = createMockAPI();
    // Mock git commands to succeed
    pi.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "add") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "git" && args[0] === "diff") return { code: 1, stdout: "", stderr: "" };
      if (cmd === "git" && args[0] === "commit") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "git" && args[0] === "rev-parse") return { code: 0, stdout: "abc1234", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    mod.default(pi as any);

    const createGoal = pi.getTool("create_goal");
    const logIteration = pi.getTool("log_iteration");
    const getGoal = pi.getTool("get_goal");
    const ctx = createMockCtx();
    await createGoal.execute("c1", { objective: "test", budget: 5 }, undefined, undefined, ctx);

    const result = await logIteration.execute("c2", {
      hypothesis: "add caching", result: "improved", cost: 0.5, status: "kept",
    }, undefined, undefined, ctx);

    expect(result.content[0].text).toContain("Iteration 1");
    expect(result.content[0].text).toContain("kept");
    expect(result.details.iteration.n).toBe(1);
    expect(result.details.iteration.commit).toBe("abc1234");

    // Verify get_goal sees the iteration
    const state = await getGoal.execute("c3", {}, undefined, undefined, ctx);
    expect(state.content[0].text).toContain("Iterations: 1");
    expect(state.content[0].text).toContain("$0.50");
  });

  test("log_iteration marks budget_limited and still records iteration", async () => {
    const mod = await import("./index.ts");
    const pi = createMockAPI();
    pi.exec.mockImplementation(async () => ({ code: 0, stdout: "", stderr: "" }));
    mod.default(pi as any);

    const createGoal = pi.getTool("create_goal");
    const logIteration = pi.getTool("log_iteration");
    const ctx = createMockCtx();
    await createGoal.execute("c1", { objective: "test", budget: 1 }, undefined, undefined, ctx);

    // Cost exceeds budget
    const result = await logIteration.execute("c2", {
      hypothesis: "big change", result: "costly", cost: 2, status: "kept",
    }, undefined, undefined, ctx);

    expect(result.content[0].text).toContain("Budget exhausted");
    expect(result.content[0].text).toContain("Iteration 1 recorded");
    expect(result.details.goal.status).toBe("budget_limited");
    expect(result.details.iteration.n).toBe(1);
  });

  test("log_iteration resets blocked counter on kept", async () => {
    const mod = await import("./index.ts");
    const pi = createMockAPI();
    pi.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "diff") return { code: 1, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    mod.default(pi as any);

    const createGoal = pi.getTool("create_goal");
    const updateGoal = pi.getTool("update_goal");
    const logIteration = pi.getTool("log_iteration");
    const ctx = createMockCtx();
    await createGoal.execute("c1", { objective: "test", budget: 5 }, undefined, undefined, ctx);

    // Bump blocked count
    await updateGoal.execute("c2", { status: "blocked", blocker: "x" }, undefined, undefined, ctx);
    await updateGoal.execute("c3", { status: "blocked", blocker: "x" }, undefined, undefined, ctx);

    // Progress resets counter
    await logIteration.execute("c4", {
      hypothesis: "try again", result: "progress", cost: 0.1, status: "kept",
    }, undefined, undefined, ctx);

    const getGoal = pi.getTool("get_goal");
    const state = await getGoal.execute("c5", {}, undefined, undefined, ctx);
    expect(state.content[0].text).not.toContain("Blocked");
  });

  test("log_iteration rejects when no active goal", async () => {
    const mod = await import("./index.ts");
    const pi = createMockAPI();
    mod.default(pi as any);

    const logIteration = pi.getTool("log_iteration");
    const ctx = createMockCtx();
    const result = await logIteration.execute("c1", {
      hypothesis: "test", result: "test", cost: 0.1, status: "kept",
    }, undefined, undefined, ctx);

    expect(result.content[0].text).toContain("No active goal");
  });

  // --- /goal command ---

  test("/goal pause and resume", async () => {
    const mod = await import("./index.ts");
    const pi = createMockAPI();
    mod.default(pi as any);

    const createGoal = pi.getTool("create_goal");
    const goalCmd = pi.getCommand("goal");
    const ctx = createMockCtx();
    await createGoal.execute("c1", { objective: "test", budget: 5 }, undefined, undefined, ctx);

    // Pause
    await goalCmd.handler("pause", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Paused — /goal resume to continue", "info");

    // Resume
    await goalCmd.handler("resume", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Resumed — fresh blocked audit", "info");
  });

  test("/goal clear removes goal", async () => {
    const mod = await import("./index.ts");
    const pi = createMockAPI();
    mod.default(pi as any);

    const createGoal = pi.getTool("create_goal");
    const goalCmd = pi.getCommand("goal");
    const ctx = createMockCtx();
    await createGoal.execute("c1", { objective: "test", budget: 5 }, undefined, undefined, ctx);

    await goalCmd.handler("clear", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Cleared", "info");

    // Goal should be gone
    const getGoal = pi.getTool("get_goal");
    const result = await getGoal.execute("c2", {}, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("No active goal");
  });

  test("/goal status shows current goal", async () => {
    const mod = await import("./index.ts");
    const pi = createMockAPI();
    mod.default(pi as any);

    const createGoal = pi.getTool("create_goal");
    const goalCmd = pi.getCommand("goal");
    const ctx = createMockCtx();
    await createGoal.execute("c1", { objective: "test goal", budget: 5 }, undefined, undefined, ctx);

    await goalCmd.handler("status", ctx);
    expect(ctx.ui.notify).toHaveBeenCalled();
    const msg = ctx.ui.notify.mock.calls[0]![0];
    expect(msg).toContain("test goal");
    expect(msg).toContain("active");
  });

  test("/goal pause rejects when no active goal", async () => {
    const mod = await import("./index.ts");
    const pi = createMockAPI();
    mod.default(pi as any);

    const goalCmd = pi.getCommand("goal");
    const ctx = createMockCtx();
    await goalCmd.handler("pause", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("No active goal", "warning");
  });

  test("/goal resume resets blocked counter", async () => {
    const mod = await import("./index.ts");
    const pi = createMockAPI();
    mod.default(pi as any);

    const createGoal = pi.getTool("create_goal");
    const updateGoal = pi.getTool("update_goal");
    const goalCmd = pi.getCommand("goal");
    const getGoal = pi.getTool("get_goal");
    const ctx = createMockCtx();
    await createGoal.execute("c1", { objective: "test", budget: 5 }, undefined, undefined, ctx);

    // Bump blocked count
    await updateGoal.execute("c2", { status: "blocked", blocker: "x" }, undefined, undefined, ctx);
    await updateGoal.execute("c3", { status: "blocked", blocker: "x" }, undefined, undefined, ctx);

    // Pause and resume
    await goalCmd.handler("pause", ctx);
    await goalCmd.handler("resume", ctx);

    // Blocked count should be reset
    const state = await getGoal.execute("c4", {}, undefined, undefined, ctx);
    expect(state.content[0].text).not.toContain("Blocked");
  });
});
