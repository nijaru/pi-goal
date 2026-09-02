/**
 * pi-goal: a small, session-scoped goal supervisor.
 *
 * Goal truth lives in typed events in the current Pi session branch. Runtime
 * state only owns the currently running provider cycle and the one queued
 * continuation Pi can deliver.
 */
import type {
  AgentEndEvent,
  AgentSettledEvent,
  AgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionCompactEvent,
  SessionTreeEvent,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { GoalState, RunOwner, Usage } from "./domain.ts";
import { GoalController } from "./controller.ts";
import { GoalStore } from "./store.ts";

const GOAL_CONTEXT = "pi-goal/context";
const GOAL_CONTINUATION = "pi-goal/continuation";
const MAX_OBJECTIVE = 4_000;
const GOAL_TOOLS = ["get_goal", "update_goal"] as const;
const CONTROL_TOOLS = new Set(["create_goal", ...GOAL_TOOLS]);

type Ctx = ExtensionContext & { signal?: AbortSignal };

type RuntimeRun = {
  runId: string;
  owner: RunOwner;
  accountedAtMs: number;
  turnMarkers: Set<string>;
  seenTurnMessages: WeakSet<object>;
  nextTurnSequence: number;
  lastStopReason?: string;
};

const clone = <T>(value: T): T => structuredClone(value);
const truncate = (value: string, max = 2_000): string => Array.from(value).length > max ? `${Array.from(value).slice(0, max).join("")}…` : value;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function lastStopReason(messages: readonly unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isRecord(message) && message.role === "assistant" && typeof message.stopReason === "string") return message.stopReason;
  }
  return undefined;
}

function fmtCost(value: number): string {
  return `$${value.toFixed(2)}`;
}

function validateObjective(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("objective is required.");
  if (value.length > MAX_OBJECTIVE) throw new Error(`objective must be ${MAX_OBJECTIVE} characters or fewer.`);
  return value.trim();
}

function usageFrom(value: unknown): Usage {
  const usage = isRecord(value) && isRecord(value.usage) ? value.usage : isRecord(value) ? value : {};
  const finite = (candidate: unknown): number => typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 ? candidate : 0;
  const costValue = usage.cost;
  const cost = finite(typeof costValue === "number" ? costValue : isRecord(costValue) ? costValue.total : 0);
  const inputTokens = finite(typeof usage.input === "number" ? usage.input : usage.inputTokens);
  const outputTokens = finite(typeof usage.output === "number" ? usage.output : usage.outputTokens);
  const totalTokens = finite(typeof usage.totalTokens === "number" ? usage.totalTokens : inputTokens + outputTokens);
  return {
    turns: 0,
    inputTokens: Math.floor(inputTokens),
    outputTokens: Math.floor(outputTokens),
    totalTokens: Math.floor(totalTokens),
    cost,
    executionSeconds: 0,
  };
}

function addUsage(left: Usage, right: Usage): Usage {
  return {
    turns: 0,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    cost: left.cost + right.cost,
    executionSeconds: 0,
  };
}

function elapsed(state: GoalState): string {
  const seconds = state.usage.executionSeconds;
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function continuationPrompt(state: GoalState): string {
  return [
    "Continue the active goal.",
    "Work on the objective now using the available tools. Do not reply with a plan only.",
    "When the objective is genuinely complete, call update_goal with status complete. If the work is genuinely blocked and cannot proceed without user input or an external change, call update_goal with status blocked.",
    `Objective: ${state.objective}`,
  ].join("\n\n");
}

function details(state: GoalState): Record<string, unknown> {
  return { ...clone(state) };
}

export default function piGoal(pi: ExtensionAPI): void {
  let activeCtx: Ctx | null = null;
  let controller: GoalController | null = null;
  let controllerSessionId: string | null = null;
  let runtimeRun: RuntimeRun | null = null;
  let userPromptPending = false;
  const userSupersededDispatches = new Set<string>();
  let agentCycleActive = false;
  let startupPending = false;
  let dispatchTimer: ReturnType<typeof setTimeout> | undefined;
  let compactionRecovery: { goalId: string } | null = null;

  function clearDispatchTimer(): void {
    if (dispatchTimer !== undefined) clearTimeout(dispatchTimer);
    dispatchTimer = undefined;
  }

  function syncTools(state: GoalState | null): void {
    let current: string[];
    try {
      current = pi.getActiveTools();
    } catch {
      current = [];
    }
    const names = new Set(current);
    names.add("create_goal");
    for (const name of GOAL_TOOLS) {
      if (state?.status === "active") names.add(name);
      else names.delete(name);
    }
    const next = [...names];
    if (next.length === current.length && next.every((name, index) => name === current[index])) return;
    pi.setActiveTools(next);
  }

  function updateWidget(state: GoalState | null): void {
    const ctx = activeCtx;
    if (!ctx?.hasUI) return;
    if (!state || state.status === "cleared") {
      ctx.ui.setWidget("goal", undefined);
      return;
    }
    ctx.ui.setWidget("goal", (_tui, theme) => ({
      render(width: number) {
        const title = " Goal ";
        const status = state.status === "complete" ? "✓" : state.status === "active" ? "◉" : state.status === "blocked" ? "⊘" : "⏸";
        const heading = `${status} ${state.status} · ${elapsed(state)}`;
        return [
          truncateToWidth(theme.fg("borderMuted", "───") + theme.fg("accent", title) + theme.fg("borderMuted", "─".repeat(Math.max(0, width - 4 - visibleWidth(title)))), width),
          truncateToWidth(`  ${theme.fg(state.status === "active" ? "accent" : state.status === "complete" ? "success" : "warning", heading)}`, width),
          truncateToWidth(`  ${theme.fg("dim", truncate(state.objective, Math.max(1, width - 4)))}`, width),
        ];
      },
      invalidate() {},
    }));
  }

  function host(ctx: Ctx) {
    return {
      sendContinuation: (message: { dispatchId: string; goalId: string; runId: string; content: string }) => {
        clearDispatchTimer();
        pi.sendMessage({
          customType: GOAL_CONTINUATION,
          content: message.content,
          display: false,
          details: message,
        }, { triggerTurn: true, deliverAs: "followUp" });
        dispatchTimer = setTimeout(() => {
          if (controller?.state?.pendingDispatch?.dispatchId !== message.dispatchId) return;
          clearDispatchTimer();
          void controller.failContinuation(message.dispatchId, "continuation was not acknowledged by Pi").catch(() => undefined);
        }, 30_000);
      },
      stateChanged: (state: GoalState | null) => {
        syncTools(state);
        updateWidget(state);
      },
    };
  }

  function ensure(ctx: Ctx): GoalController {
    activeCtx = ctx;
    const sessionId = ctx.sessionManager.getSessionId();
    if (!controller || controllerSessionId !== sessionId) {
      const store = new GoalStore(pi, sessionId, ctx.sessionManager.getBranch() as unknown[]);
      controller = new GoalController(store, host(ctx));
      controllerSessionId = sessionId;
      syncTools(controller.state);
      updateWidget(controller.state);
    }
    return controller;
  }

  function stateOrNull(ctx: Ctx): GoalState | null {
    try {
      return ensure(ctx).state;
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : "Could not reconstruct goal state.", "error");
      return null;
    }
  }

  function beginRuntime(run: GoalState["activeRun"]): void {
    if (!run) return;
    runtimeRun = {
      runId: run.runId,
      owner: run.owner,
      accountedAtMs: Date.now(),
      turnMarkers: new Set(),
      seenTurnMessages: new WeakSet(),
      nextTurnSequence: 0,
      lastStopReason: undefined,
    };
  }

  function accountExecution(ctx: Ctx): Promise<void> {
    const run = runtimeRun;
    const currentController = controller;
    if (!run || !currentController || currentController.state?.activeRun?.runId !== run.runId) return Promise.resolve();
    const at = Date.now();
    const seconds = Math.floor((at - run.accountedAtMs) / 1_000);
    if (seconds <= 0) return Promise.resolve();
    run.accountedAtMs += seconds * 1_000;
    return currentController.accountExecution(run.runId, seconds).then(() => undefined).catch(error => {
      ctx.ui.notify(error instanceof Error ? error.message : "Could not account execution time.", "error");
    });
  }

  async function finishRuntime(ctx: Ctx): Promise<void> {
    const currentController = controller;
    if (!currentController) return;
    const run = runtimeRun;
    if (run) {
      await accountExecution(ctx);
      const state = currentController.state;
      if (state?.activeRun?.runId === run.runId) {
        if (state.status === "active" && (run.lastStopReason === "error" || run.lastStopReason === "aborted")) {
          await currentController.endRun(run.runId);
          await currentController.changeStatus("paused", run.lastStopReason === "aborted" ? "provider run interrupted" : "provider request failed").catch(() => undefined);
        } else {
          await currentController.endRun(run.runId);
        }
      }
      if (runtimeRun === run) runtimeRun = null;
    }

    const settled = currentController.state;
    if (settled?.status === "active" && !settled.activeRun && !settled.pendingDispatch && !userPromptPending && !startupPending) {
      await currentController.requestContinuation(continuationPrompt(settled)).catch(error => {
        ctx.ui.notify(error instanceof Error ? error.message : "Could not queue the next goal cycle.", "error");
      });
    }
    startupPending = false;
  }

  // User lifecycle actions release the goal lease but never cancel the host
  // response. Pi may still deliver a queued follow-up, so its dispatch ID is
  // remembered and drained without aborting user work.
  async function releaseRuntime(ctx: Ctx, currentController: GoalController, reason: string): Promise<void> {
    const run = runtimeRun;
    if (run) {
      await accountExecution(ctx);
      await currentController.endRun(run.runId).catch(() => undefined);
      if (runtimeRun === run) runtimeRun = null;
    }
    const pending = currentController.state?.pendingDispatch;
    if (pending) {
      userSupersededDispatches.add(pending.dispatchId);
      clearDispatchTimer();
      await currentController.supersedeContinuation(pending.dispatchId, reason).catch(() => undefined);
    }
  }

  function renderText(result: any): Text {
    return new Text(result?.content?.[0]?.type === "text" ? result.content[0].text : "", 0, 0);
  }

  pi.on("session_start", async (event, ctx) => {
    activeCtx = ctx;
    controller = null;
    controllerSessionId = null;
    runtimeRun = null;
    agentCycleActive = false;
    clearDispatchTimer();
    compactionRecovery = null;
    userPromptPending = false;
    userSupersededDispatches.clear();
    startupPending = true;
    let current = stateOrNull(ctx);
    if (current?.activeRun) {
      await ensure(ctx).endRun(current.activeRun.runId);
      current = stateOrNull(ctx);
      if (current?.status === "active") current = await ensure(ctx).changeStatus("paused", "previous provider run was interrupted by session restart");
    }
    if (current?.pendingDispatch) {
      userSupersededDispatches.add(current.pendingDispatch.dispatchId);
      await ensure(ctx).supersedeContinuation(current.pendingDispatch.dispatchId, "reload superseded the pending continuation").catch(() => undefined);
    }
    if (event.reason === "fork" && current && current.status !== "cleared") await ensure(ctx).clear("forked session starts without the parent goal");
  });

  pi.on("session_tree", async (_event: SessionTreeEvent, ctx) => {
    ctx.abort();
    controller = null;
    controllerSessionId = null;
    runtimeRun = null;
    agentCycleActive = false;
    clearDispatchTimer();
    compactionRecovery = null;
    userPromptPending = false;
    userSupersededDispatches.clear();
    startupPending = false;
    let current = stateOrNull(ctx);
    if (current?.activeRun) {
      await ensure(ctx).endRun(current.activeRun.runId);
      current = stateOrNull(ctx);
      if (current?.status === "active") current = await ensure(ctx).changeStatus("paused", "previous provider run was interrupted by tree navigation");
    }
    if (current?.pendingDispatch) {
      userSupersededDispatches.add(current.pendingDispatch.dispatchId);
      await ensure(ctx).supersedeContinuation(current.pendingDispatch.dispatchId, "tree navigation superseded the pending continuation").catch(() => undefined);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    activeCtx = ctx;
    const shuttingController = controller;
    const shuttingRun = runtimeRun;
    clearDispatchTimer();
    compactionRecovery = null;
    if (shuttingController && shuttingRun && shuttingController.state?.activeRun?.runId === shuttingRun.runId) {
      await accountExecution(ctx);
      if (controller === shuttingController) {
        await shuttingController.endRun(shuttingRun.runId);
        if (shuttingController.state?.status === "active") await shuttingController.changeStatus("paused", "provider run interrupted by session shutdown");
      }
    }
    runtimeRun = null;
    agentCycleActive = false;
    userSupersededDispatches.clear();
    controller = null;
    controllerSessionId = null;
  });

  pi.on("session_before_compact", async (event, ctx) => {
    let current = stateOrNull(ctx);
    if (current?.pendingDispatch) {
      userSupersededDispatches.add(current.pendingDispatch.dispatchId);
      clearDispatchTimer();
      current = await ensure(ctx).supersedeContinuation(current.pendingDispatch.dispatchId, "compaction superseded the pending continuation");
    }
    if (event.reason !== "manual") {
      if (current) ensure(ctx).snapshot();
      return;
    }

    const recoverGoalId = current && (current.status === "active" || (current.status === "paused" && current.stopReason === "provider run interrupted")) ? current.id : undefined;
    if (runtimeRun && current?.activeRun?.runId === runtimeRun.runId && current.status === "active") {
      await accountExecution(ctx);
      await ensure(ctx).endRun(runtimeRun.runId);
      runtimeRun = null;
    } else if (runtimeRun) {
      runtimeRun = null;
    }
    const afterRun = stateOrNull(ctx);
    if (recoverGoalId && afterRun?.id === recoverGoalId && (afterRun.status === "active" || afterRun.status === "paused")) {
      if (afterRun.status === "active") await ensure(ctx).changeStatus("paused", "compaction interrupted the active goal run").catch(() => undefined);
      compactionRecovery = { goalId: recoverGoalId };
    }
    const after = stateOrNull(ctx);
    if (after) ensure(ctx).snapshot();
  });

  pi.on("session_compact", async (event: SessionCompactEvent, ctx: Ctx) => {
    await accountExecution(ctx);
    const recovery = compactionRecovery;
    compactionRecovery = null;
    if (!recovery) return;
    const current = stateOrNull(ctx);
    if (!current || current.id !== recovery.goalId || current.status !== "paused") return;
    const resumed = await ensure(ctx).changeStatus("active", "recovered after manual compaction");
    await ensure(ctx).requestContinuation(continuationPrompt(resumed)).catch(error => ctx.ui.notify(error instanceof Error ? error.message : "Could not resume after compaction.", "error"));
  });

  pi.on("session_compact_failed", async (_event: any, ctx) => {
    clearDispatchTimer();
    const current = stateOrNull(ctx);
    if (current?.pendingDispatch) {
      userSupersededDispatches.add(current.pendingDispatch.dispatchId);
      await ensure(ctx).supersedeContinuation(current.pendingDispatch.dispatchId, "failed compaction superseded the pending continuation").catch(() => undefined);
    }
  });

  pi.on("input", async (event: any, ctx) => {
    if (event.source === "interactive" || event.source === "rpc") {
      userPromptPending = true;
      startupPending = false;
      const current = stateOrNull(ctx);
      if (current?.pendingDispatch) {
        userSupersededDispatches.add(current.pendingDispatch.dispatchId);
        clearDispatchTimer();
        await ensure(ctx).supersedeContinuation(current.pendingDispatch.dispatchId, "user input superseded the continuation").catch(() => undefined);
      }
    }
  });

  pi.on("before_agent_start", (_event, ctx) => {
    const current = stateOrNull(ctx);
    if (!current || current.status !== "active") return;
    return {
      message: {
        customType: GOAL_CONTEXT,
        display: false,
        content: [
          "## Active goal",
          `Objective: ${current.objective}`,
          "Work toward the objective using the available tools. Call update_goal with status complete only when the objective is actually achieved. Call it with status blocked only when the same blocking condition has made further work impossible without user input or an external change.",
        ].join("\n\n"),
      },
    };
  });

  pi.on("agent_start", async (_event: AgentStartEvent, ctx) => {
    agentCycleActive = true;
    const current = stateOrNull(ctx);
    if (!current || current.status !== "active" || runtimeRun || current.pendingDispatch || !userPromptPending) return;
    const next = await ensure(ctx).startRun("user").catch(() => null);
    if (next?.activeRun) beginRuntime(next.activeRun);
  });

  pi.on("message_start", async (event: any, ctx) => {
    const message = event.message;
    const dispatchId = message?.customType === GOAL_CONTINUATION && message.details?.dispatchId;
    if (typeof dispatchId === "string") {
      const userSuperseded = userSupersededDispatches.delete(dispatchId);
      if (userPromptPending || userSuperseded) {
        clearDispatchTimer();
        await ensure(ctx).supersedeContinuation(dispatchId, "user input superseded the continuation").catch(() => undefined);
        // Pi has no queue-removal API. Let a user-superseded follow-up drain as
        // an ordinary hidden message rather than aborting user work.
        return;
      }
      clearDispatchTimer();
      const acknowledged = await ensure(ctx).acknowledgeContinuation(dispatchId).catch(() => null);
      if (acknowledged?.activeRun) {
        beginRuntime(acknowledged.activeRun);
      } else {
        await ensure(ctx).failContinuation(dispatchId, "continuation acknowledgement failed").catch(() => undefined);
        // Pi has no queue-removal API. Make a stale queued message inert and
        // let it drain; aborting here would surface a provider error to the
        // user and can cancel unrelated work.
        if (isRecord(message)) message.content = "Ignore this stale goal continuation.";
      }
      return;
    }
    if (message?.role === "user") userPromptPending = false;
    if (message?.role === "user" && !runtimeRun) {
      const current = stateOrNull(ctx);
      if (current?.pendingDispatch) {
        userSupersededDispatches.add(current.pendingDispatch.dispatchId);
        clearDispatchTimer();
        await ensure(ctx).supersedeContinuation(current.pendingDispatch.dispatchId, "user message superseded the continuation").catch(() => undefined);
      }
      const next = await ensure(ctx).startRun("user").catch(() => null);
      if (next?.activeRun) beginRuntime(next.activeRun);
    }
  });

  pi.on("before_provider_request", (_event, ctx) => {
    // Keep tool visibility synchronized, but never cancel a provider request.
    // User and session lifecycle ownership belongs to Pi; a detached provider
    // cycle simply runs without charging or continuing the goal.
    stateOrNull(ctx);
  });

  pi.on("turn_end", async (event: TurnEndEvent, ctx) => {
    const run = runtimeRun;
    const current = stateOrNull(ctx);
    if (!run || !current || current.activeRun?.runId !== run.runId) return;
    if (isRecord(event.message)) {
      if (run.seenTurnMessages.has(event.message)) return;
      run.seenTurnMessages.add(event.message);
    }
    const message = isRecord(event.message) ? event.message : undefined;
    const timestamp = typeof message?.timestamp === "number" ? message.timestamp : undefined;
    const responseId = typeof message?.responseId === "string" ? message.responseId : undefined;
    const turnMarker = timestamp === undefined ? undefined : `${timestamp}:${responseId ?? ""}:${message?.stopReason ?? ""}`;
    if (turnMarker !== undefined && run.turnMarkers.has(turnMarker)) return;
    if (turnMarker !== undefined) run.turnMarkers.add(turnMarker);
    const turnId = `${run.runId}:${run.nextTurnSequence++}`;
    await accountExecution(ctx);
    let usage = usageFrom(event.message);
    for (const toolResult of event.toolResults ?? []) usage = addUsage(usage, usageFrom(toolResult));
    await ensure(ctx).accountTurn(run.runId, turnId, usage).catch(error => ctx.ui.notify(error instanceof Error ? error.message : "Could not account provider usage.", "error"));
  });

  pi.on("agent_end", (event: AgentEndEvent) => {
    if (runtimeRun) runtimeRun.lastStopReason = lastStopReason(event.messages);
  });

  pi.on("agent_settled", async (_event: AgentSettledEvent, ctx) => {
    agentCycleActive = false;
    await finishRuntime(ctx);
  });

  pi.registerTool({
    name: "create_goal",
    label: "Create Goal",
    description: "Create a goal only when explicitly requested by the user. Fails while another goal in this session is unfinished.",
    promptSnippet: "Create a persistent goal",
    promptGuidelines: ["Use only when the user explicitly requests autonomous goal work."],
    parameters: Type.Object({ objective: Type.String({ description: "The concrete objective to pursue." }) }),
    async execute(_id, params, _signal, _update, ctx) {
      const objective = validateObjective(params.objective);
      const currentController = ensure(ctx);
      const goal = await currentController.create({ objective });
      let result = goal;
      if (agentCycleActive && !runtimeRun && !goal.activeRun) {
        result = await currentController.startRun("user");
        if (result.activeRun) beginRuntime(result.activeRun);
      }
      return { content: [{ type: "text" as const, text: `Goal created\nObjective: ${result.objective}` }], details: { goal: details(result) } };
    },
    renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("create_goal ")) + theme.fg("accent", truncate(args.objective, 60)), 0, 0); },
    renderResult: renderText,
  });

  pi.registerTool({
    name: "get_goal",
    label: "Get Goal",
    description: "Read the current goal, status, usage, and blocker.",
    promptSnippet: "Inspect the current goal",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      const goal = stateOrNull(ctx);
      if (!goal || goal.status === "cleared") return { content: [{ type: "text" as const, text: "No active goal." }], details: {} };
      return { content: [{ type: "text" as const, text: [`Objective: ${goal.objective}`, `Status: ${goal.status}`, `Usage: ${fmtCost(goal.usage.cost)} · ${goal.usage.turns} turns · ${elapsed(goal)}`, goal.stopReason ? `Stop reason: ${goal.stopReason}` : "", goal.blocker ? `Blocker: ${goal.blocker}` : ""].filter(Boolean).join("\n") }], details: { goal: details(goal) } };
    },
    renderCall(_args, theme) { return new Text(theme.fg("toolTitle", theme.bold("get_goal")), 0, 0); },
    renderResult: renderText,
  });

  pi.registerTool({
    name: "update_goal",
    label: "Update Goal",
    description: "Mark the active goal complete or genuinely blocked.",
    promptSnippet: "Complete or block the active goal",
    promptGuidelines: ["Complete only when the objective is actually achieved.", "Block only when progress is impossible without user input or an external change."],
    parameters: Type.Object({ status: StringEnum(["complete", "blocked"] as const) }),
    async execute(_id, params, _signal, _update, ctx) {
      const currentController = ensure(ctx);
      const goal = params.status === "complete"
        ? await currentController.changeStatus("complete", "completed by model")
        : await currentController.changeStatus("blocked", "blocked by model");
      return { content: [{ type: "text" as const, text: `Goal ${params.status}\nObjective: ${goal.objective}` }], details: { goal: details(goal) }, terminate: true };
    },
    renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("update_goal ")) + theme.fg(args.status === "complete" ? "success" : "warning", args.status), 0, 0); },
    renderResult: renderText,
  });

  function statusText(state: GoalState | null): string {
    if (!state || state.status === "cleared") return "No active goal.";
    return [`🎯 [${state.status}] ${state.objective}`, `Usage: ${fmtCost(state.usage.cost)} · ${state.usage.turns} turns · execution ${elapsed(state)}`, state.stopReason ? `Stop reason: ${state.stopReason}` : "", state.blocker ? `Blocker: ${state.blocker}` : ""].filter(Boolean).join("\n");
  }

  pi.registerCommand("goal", {
    description: "Create, inspect, pause, resume, or clear a goal",
    handler: async (args, ctx) => {
      const raw = (args ?? "").trim();
      if (!raw || raw === "status") { ctx.ui.notify(statusText(stateOrNull(ctx)), "info"); return; }
      const command = raw.split(/\s+/, 1)[0]?.toLowerCase();
      const currentController = ensure(ctx);
      if (command === "pause") {
        startupPending = false;
        const state = currentController.state;
        if (!state || state.status !== "active") throw new Error("Only an active goal can be paused.");
        await releaseRuntime(ctx, currentController, "paused by user");
        await currentController.changeStatus("paused", "paused by user");
        ctx.ui.notify("Goal paused. /goal resume continues it.", "info");
        return;
      }
      if (command === "resume") {
        startupPending = false;
        const state = currentController.state;
        if (!state || !["paused", "blocked"].includes(state.status)) throw new Error("Only a paused or blocked goal can be resumed.");
        const resumed = await currentController.changeStatus("active", "resumed by user");
        if (!agentCycleActive) await currentController.requestContinuation(continuationPrompt(resumed));
        ctx.ui.notify(agentCycleActive ? "Goal resumed; it continues after the running response settles." : "Goal resumed.", "info");
        return;
      }
      if (["clear", "stop", "cancel"].includes(command ?? "")) {
        startupPending = false;
        const state = currentController.state;
        if (!state || state.status === "cleared") { ctx.ui.notify("No active goal.", "info"); return; }
        await releaseRuntime(ctx, currentController, "cleared by user");
        await currentController.clear("cleared by user");
        ctx.ui.notify("Goal cleared.", "info");
        return;
      }
      startupPending = false;
      const goal = await currentController.create({ objective: validateObjective(raw) });
      if (!agentCycleActive) await currentController.requestContinuation(continuationPrompt(goal));
      ctx.ui.notify(`Goal started: ${goal.objective}`, "info");
    },
  });
}
