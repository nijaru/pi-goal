/**
 * pi-goal: a session-scoped goal supervisor.
 *
 * The domain reducer owns goal truth. The event store owns branch replay. This
 * adapter owns only Pi lifecycle translation and provider effects.
 */
import type {
  AgentEndEvent,
  AgentSettledEvent,
  AgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionCompactEvent,
  SessionTreeEvent,
  ToolExecutionEndEvent,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import type { GoalState, ProgressKind, RunOwner, Usage } from "./domain.ts";
import { GoalController } from "./controller.ts";
import { GoalStore, GoalStoreError, validateLimits } from "./store.ts";

const GOAL_CONTEXT = "pi-goal/context";
const GOAL_CONTINUATION = "pi-goal/continuation";
const MAX_OBJECTIVE = 4_000;
const MAX_TEXT = 2_000;
const MAX_EVIDENCE = 4_000;
const MAX_COST = 1_000_000;
const MAX_TURNS = 10_000;
const MAX_EXECUTION_SECONDS = 31_536_000;
const GOAL_TOOLS = ["get_goal", "goal_checkpoint", "evaluate_goal", "update_goal"] as const;
const CONTROL_TOOLS = new Set(["create_goal", ...GOAL_TOOLS]);
const READ_ONLY_INSPECTION_TOOLS = new Set(["read", "grep", "find", "ls"]);

type Ctx = ExtensionContext & { signal?: AbortSignal };

type RuntimeRun = {
  runId: string;
  owner: RunOwner;
  startedAtMs: number;
  accountedAtMs: number;
  turnIds: Set<string>;
  turnMarkers: Set<string>;
  seenTurnMessages: WeakSet<object>;
  nextTurnSequence: number;
  checkpointSeen: boolean;
  lastProgress: ProgressKind | null;
  lastStopReason?: string;
};

const clone = <T>(value: T): T => structuredClone(value);
const truncate = (value: string, max = MAX_TEXT): string => Array.from(value).length > max ? `${Array.from(value).slice(0, max).join("")}…` : value;
const now = (): string => new Date().toISOString();
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

function validateText(value: unknown, label: string, max = MAX_TEXT): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  if (value.length > max) throw new Error(`${label} must be ${max} characters or fewer.`);
  return value.trim();
}

function numeric(value: unknown, label: string, max: number): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > max) throw new Error(`${label} must be finite, positive, and no greater than ${max}.`);
  return value;
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

function recentProgress(state: GoalState): string {
  return state.progress.checkpoints.slice(-3).map(checkpoint =>
    `${checkpoint.sequence}. ${checkpoint.progress}: ${truncate(checkpoint.action, 100)} — ${truncate(checkpoint.observation, 180)}`,
  ).join("\n");
}

function continuationPrompt(state: GoalState, forceAction: boolean): string {
  return [
    forceAction ? "The previous cycle did not demonstrate progress." : "Continue the active goal.",
    "Perform one concrete inspect/action step now; do not reply with a plan only.",
    "When the step finishes, call goal_checkpoint with the action, observation, progress classification, and evidence.",
    `Objective: ${state.objective}`,
    `Definition of done: ${state.doneWhen}`,
    recentProgress(state) ? `Recent checkpoints:\n${recentProgress(state)}` : "No checkpoint has been recorded yet.",
  ].join("\n\n");
}

function evaluationPrompt(state: GoalState): string {
  return [
    "Evaluate this goal in a fresh, read-only context.",
    "Do not change files, run mutating commands, or trust the goal owner's conclusion.",
    `Objective: ${state.objective}`,
    `Definition of done: ${state.doneWhen}`,
    `Current revision: ${state.revision}`,
    recentProgress(state) || "No progress checkpoints recorded.",
    "Return achieved only with concrete evidence that the definition of done is satisfied.",
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
  let agentCycleActive = false;
  let startupPending = false;
  let dispatchTimer: ReturnType<typeof setTimeout> | undefined;
  let executionTimer: ReturnType<typeof setTimeout> | undefined;
  let compactionRecovery: { goalId: string } | null = null;

  function clearDispatchTimer(): void {
    if (dispatchTimer !== undefined) clearTimeout(dispatchTimer);
    dispatchTimer = undefined;
  }

  function clearExecutionTimer(): void {
    if (executionTimer !== undefined) clearTimeout(executionTimer);
    executionTimer = undefined;
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
      abort: () => ctx.abort(),
      sendContinuation: (message: { dispatchId: string; goalId: string; runId: string; forceAction: boolean; content: string }) => {
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
    clearExecutionTimer();
    const at = Date.now();
    runtimeRun = { runId: run.runId, owner: run.owner, startedAtMs: at, accountedAtMs: at, turnIds: new Set(), turnMarkers: new Set(), seenTurnMessages: new WeakSet(), nextTurnSequence: 0, checkpointSeen: false, lastProgress: null, lastStopReason: undefined };
    const limit = controller?.state?.limits.maxExecutionSeconds;
    if (limit !== null && limit !== undefined) {
      const used = controller?.state?.usage.executionSeconds ?? 0;
      const remaining = Math.max(0, limit - used);
      executionTimer = setTimeout(() => {
        if (runtimeRun?.runId !== run.runId || controller?.state?.activeRun?.runId !== run.runId) return;
        const boundaryCtx = activeCtx;
        if (!boundaryCtx) return;
        void accountExecution(boundaryCtx).finally(() => {
          if (runtimeRun?.runId === run.runId) boundaryCtx.abort();
        });
      }, remaining * 1_000);
    }
  }

  function accountExecution(ctx: Ctx): Promise<void> {
    const run = runtimeRun;
    const controllerNow = controller;
    if (!run || !controllerNow || !controllerNow.state || controllerNow.state.activeRun?.runId !== run.runId) return Promise.resolve();
    const at = Date.now();
    const seconds = Math.floor((at - run.accountedAtMs) / 1_000);
    if (seconds <= 0) return Promise.resolve();
    run.accountedAtMs += seconds * 1_000;
    return controllerNow.accountExecution(run.runId, seconds).then(() => undefined).catch(error => {
      ctx.ui.notify(error instanceof Error ? error.message : "Could not account execution time.", "error");
    });
  }

  async function finishRuntime(ctx: Ctx): Promise<void> {
    const controllerNow = controller;
    if (!controllerNow) return;
    const run = runtimeRun;
    if (run) {
      await accountExecution(ctx);
      const state = controllerNow.state;
      if (state?.activeRun?.runId === run.runId) {
        const stopReason = run.lastStopReason;
        if (state.status === "active" && (stopReason === "error" || stopReason === "aborted")) {
          await controllerNow.endRun(run.runId);
          await controllerNow.changeStatus("paused", stopReason === "aborted" ? "provider run interrupted" : "provider request failed").catch(() => undefined);
          clearExecutionTimer();
          if (runtimeRun === run) runtimeRun = null;
          startupPending = false;
          return;
        }
        if (!run.checkpointSeen && state.status === "active") {
          await controllerNow.checkpoint(run.runId, {
            action: "provider cycle",
            observation: "The provider cycle ended without a goal_checkpoint.",
            progress: "none",
            evidence: "No checkpoint was recorded.",
          }).catch(() => undefined);
        }
        await controllerNow.endRun(run.runId);
      }
      clearExecutionTimer();
      if (runtimeRun === run) runtimeRun = null;
    }
    // A cycle that settled without a live lease (paused, cleared, or replaced
    // mid-run) must not strand an active goal: continue once no user input,
    // startup work, or queued dispatch owns the next cycle.
    const settled = controllerNow.state;
    if (settled?.status === "active" && !settled.activeRun && !settled.pendingDispatch && !userPromptPending && !startupPending) {
      const forceAction = settled.progress.consecutiveNoProgress > 0;
      await controllerNow.requestContinuation(forceAction, continuationPrompt(settled, forceAction)).catch(error => {
        ctx.ui.notify(error instanceof Error ? error.message : "Could not queue the next goal cycle.", "error");
      });
    }
    startupPending = false;
  }

  // Release the active run lease, timers, and any pending continuation without
  // aborting the host turn. The in-flight cycle finishes naturally as ordinary
  // (unaccounted) work; a still-active goal continues on the next cycle.
  async function releaseRuntime(ctx: Ctx, currentController: GoalController, reason: string): Promise<void> {
    const run = runtimeRun;
    if (run) {
      await accountExecution(ctx);
      await currentController.endRun(run.runId).catch(() => undefined);
      if (runtimeRun === run) runtimeRun = null;
    }
    clearExecutionTimer();
    const pending = currentController.state?.pendingDispatch;
    if (pending) {
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
    clearExecutionTimer();
    compactionRecovery = null;
    userPromptPending = false;
    startupPending = true;
    let current = stateOrNull(ctx);
    if (current?.activeRun) {
      await ensure(ctx).endRun(current.activeRun.runId);
      current = stateOrNull(ctx);
      if (current?.status === "active") current = await ensure(ctx).changeStatus("paused", "previous provider run was interrupted by session restart");
    }
    if (current?.status === "active") current = await ensure(ctx).invalidateActivity("session context restarted") ?? current;
    if (current?.pendingDispatch) await ensure(ctx).supersedeContinuation(current.pendingDispatch.dispatchId, "reload superseded the pending continuation").catch(() => undefined);
    if (event.reason === "fork" && current && current.status !== "cleared") await ensure(ctx).clear("forked session starts without the parent goal");
  });

  pi.on("session_tree", async (event: SessionTreeEvent, ctx) => {
    ctx.abort();
    controller = null;
    controllerSessionId = null;
    runtimeRun = null;
    agentCycleActive = false;
    clearDispatchTimer();
    clearExecutionTimer();
    compactionRecovery = null;
    userPromptPending = false;
    startupPending = false;
    let current = stateOrNull(ctx);
    if (current?.activeRun) {
      await ensure(ctx).endRun(current.activeRun.runId);
      current = stateOrNull(ctx);
      if (current?.status === "active") current = await ensure(ctx).changeStatus("paused", "previous provider run was interrupted by tree navigation");
    }
    if (current?.status === "active") current = await ensure(ctx).invalidateActivity("session tree changed") ?? current;
    if (current?.pendingDispatch) await ensure(ctx).supersedeContinuation(current.pendingDispatch.dispatchId, "tree navigation superseded the pending continuation").catch(() => undefined);
    if (event.summaryEntry?.usage) await accountExecution(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    activeCtx = ctx;
    const shuttingController = controller;
    const shuttingRun = runtimeRun;
    clearDispatchTimer();
    clearExecutionTimer();
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
    controller = null;
    controllerSessionId = null;
  });

  pi.on("session_before_compact", async (event, ctx) => {
    let current = stateOrNull(ctx);
    if (current?.pendingDispatch) {
      clearDispatchTimer();
      current = await ensure(ctx).supersedeContinuation(current.pendingDispatch.dispatchId, "compaction superseded the pending continuation");
    }
    // Automatic compaction runs inside Pi's current agent loop. Keep its lease so
    // Pi can retry/continue that loop; only the context-dependent evaluation is stale.
    if (event.reason !== "manual") {
      if (current?.status === "active") current = await ensure(ctx).invalidateActivity("context compaction changed the active context") ?? current;
      if (current) ensure(ctx).snapshot(now());
      return;
    }

    // Manual compaction aborts before this hook in Pi. Quarantine an unexpected
    // orphan too, then recover exactly once after a successful compaction. A run
    // that settled as an interruption is already paused before this hook arrives.
    const recoverGoalId = current && (
      current.status === "active" ||
      (current.status === "paused" && current.stopReason === "provider run interrupted")
    ) ? current.id : undefined;
    if (runtimeRun && current?.activeRun?.runId === runtimeRun.runId && current.status === "active") {
      await accountExecution(ctx);
      await ensure(ctx).endRun(runtimeRun.runId);
      clearExecutionTimer();
      runtimeRun = null;
    } else if (runtimeRun) {
      clearExecutionTimer();
      runtimeRun = null;
    }
    const afterRun = stateOrNull(ctx);
    if (recoverGoalId && afterRun?.id === recoverGoalId && (afterRun.status === "active" || afterRun.status === "paused")) {
      if (afterRun.status === "active") await ensure(ctx).changeStatus("paused", "compaction interrupted the active goal run").catch(() => undefined);
      compactionRecovery = { goalId: recoverGoalId };
    }
    const after = stateOrNull(ctx);
    if (after) ensure(ctx).snapshot(now());
  });

  pi.on("session_compact", async (event: SessionCompactEvent, ctx: Ctx) => {
    if (event.compactionEntry.usage) await accountExecution(ctx);
    const recovery = compactionRecovery;
    compactionRecovery = null;
    if (!recovery) return;
    const current = stateOrNull(ctx);
    if (!current || current.id !== recovery.goalId || current.status !== "paused") return;
    const resumed = await ensure(ctx).changeStatus("active", "recovered after manual compaction");
    await ensure(ctx).requestContinuation(false, continuationPrompt(resumed, false)).catch(error => ctx.ui.notify(error instanceof Error ? error.message : "Could not resume after compaction.", "error"));
  });

  pi.on("session_compact_failed", async (_event: any, ctx: Ctx) => {
    clearDispatchTimer();
    compactionRecovery = null;
    const current = stateOrNull(ctx);
    if (current?.pendingDispatch) await ensure(ctx).supersedeContinuation(current.pendingDispatch.dispatchId, "failed compaction superseded the pending continuation").catch(() => undefined);
  });

  pi.on("input", async (event: any, ctx) => {
    if (event.source === "interactive" || event.source === "rpc") {
      userPromptPending = true;
      startupPending = false;
      const current = stateOrNull(ctx);
      if (current?.pendingDispatch) {
        clearDispatchTimer();
        await ensure(ctx).supersedeContinuation(current.pendingDispatch.dispatchId, "user input superseded the continuation").catch(() => undefined);
      }
      if (current?.status === "active") await ensure(ctx).invalidateActivity("user steering changed the active context");
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
          "## Active goal protocol",
          `Objective: ${current.objective}`,
          `Definition of done: ${current.doneWhen}`,
          "Perform concrete work, then call goal_checkpoint with observed evidence.",
          "Do not claim completion without a fresh evaluation.",
          recentProgress(current) ? `Recent checkpoints:\n${recentProgress(current)}` : "No checkpoints yet.",
        ].join("\n\n"),
      },
    };
  });

  pi.on("agent_start", async (_event: AgentStartEvent, ctx) => {
    agentCycleActive = true;
    const current = stateOrNull(ctx);
    if (!current || current.status !== "active" || runtimeRun) return;
    if (current.pendingDispatch) return;
    if (!userPromptPending) return;
    const next = await ensure(ctx).startRun("user").catch(() => null);
    if (next?.activeRun) beginRuntime(next.activeRun);
  });

  pi.on("message_start", async (event: any, ctx) => {
    const message = event.message;
    const dispatchId = message?.customType === GOAL_CONTINUATION && message.details?.dispatchId;
    if (typeof dispatchId === "string") {
      if (userPromptPending) {
        clearDispatchTimer();
        await ensure(ctx).supersedeContinuation(dispatchId, "user input superseded the continuation").catch(() => undefined);
        ctx.abort();
        return;
      }
      clearDispatchTimer();
      const acknowledged = await ensure(ctx).acknowledgeContinuation(dispatchId).catch(() => null);
      if (acknowledged?.activeRun) {
        beginRuntime(acknowledged.activeRun);
      } else {
        // Stale or failed continuation: never let it reach the provider as
        // ordinary work; clear the dispatch so an active goal is not stranded.
        await ensure(ctx).failContinuation(dispatchId, "continuation acknowledgement failed").catch(() => undefined);
        ctx.abort();
      }
      return;
    }
    if (message?.role === "user") {
      userPromptPending = false;
    }
    if (message?.role === "user" && !runtimeRun) {
      const current = stateOrNull(ctx);
      if (current?.pendingDispatch) {
        clearDispatchTimer();
        await ensure(ctx).supersedeContinuation(current.pendingDispatch.dispatchId, "user message superseded the continuation").catch(() => undefined);
      }
      const next = await ensure(ctx).startRun("user").catch(() => null);
      if (next?.activeRun) beginRuntime(next.activeRun);
    }
  });

  pi.on("before_provider_request", (_event, ctx) => {
    const current = stateOrNull(ctx);
    if (!current || current.status !== "active") return;
    // Abort only goal work that outlived its lease; an ordinary or detached
    // cycle (no runtime lease) runs to completion untouched.
    if (runtimeRun && current.activeRun?.runId !== runtimeRun.runId) ctx.abort();
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
    run.turnIds.add(turnId);
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

  pi.on("tool_execution_end", async (event: ToolExecutionEndEvent, ctx) => {
    if (CONTROL_TOOLS.has(event.toolName)) return;
    const current = stateOrNull(ctx);
    if (
      !event.isError &&
      current?.evaluation &&
      current.evaluation.verdict === undefined &&
      READ_ONLY_INSPECTION_TOOLS.has(event.toolName)
    ) return;
    if (current?.status === "active") await ensure(ctx).invalidateActivity(`tool activity: ${event.toolName}`);
  });

  pi.on("user_bash", async (_event: any, ctx) => {
    const current = stateOrNull(ctx);
    if (current?.status === "active") await ensure(ctx).invalidateActivity("user bash activity");
  });

  const parameters = {
    objective: Type.String({ description: "Concrete objective." }),
    doneWhen: Type.String({ description: "Explicit, verifiable definition of done." }),
    maxCost: Type.Optional(Type.Number({ description: "Maximum USD spend." })),
    maxTurns: Type.Optional(Type.Number({ description: "Maximum provider turns." })),
    maxExecutionSeconds: Type.Optional(Type.Number({ description: "Maximum active provider execution seconds." })),
  };

  pi.registerTool({
    name: "create_goal",
    label: "Create Goal",
    description: "Create or replace a persistent goal with an explicit definition of done and optional hard limits.",
    promptSnippet: "Create a persistent goal with a verifiable definition of done",
    promptGuidelines: ["Use only when the user explicitly requests autonomous goal work.", "Always provide one objective and an explicit definition of done."],
    parameters: Type.Object(parameters),
    async execute(_id, params, _signal, _update, ctx) {
      const limits = { maxCost: numeric(params.maxCost, "maxCost", MAX_COST), maxTurns: numeric(params.maxTurns, "maxTurns", MAX_TURNS), maxExecutionSeconds: numeric(params.maxExecutionSeconds, "maxExecutionSeconds", MAX_EXECUTION_SECONDS) };
      if (limits.maxTurns !== null && !Number.isSafeInteger(limits.maxTurns)) throw new Error("maxTurns must be a safe integer.");
      validateLimits(limits);
      const objective = validateText(params.objective, "objective", MAX_OBJECTIVE);
      const doneWhen = validateText(params.doneWhen, "doneWhen", MAX_OBJECTIVE);
      const currentController = ensure(ctx);
      const replacing = currentController.state !== null && currentController.state.status !== "cleared";
      if (replacing) {
        await releaseRuntime(ctx, currentController, "replaced by a new goal");
        compactionRecovery = null;
      }
      const goal = await currentController.create({ objective, doneWhen, limits });
      let result = goal;
      if (agentCycleActive && !runtimeRun && !goal.activeRun) {
        // Bind the running cycle to the new goal with a fresh lease so the
        // model can continue and checkpoint in the same turn.
        result = await currentController.startRun("user");
        if (result.activeRun) beginRuntime(result.activeRun);
      }
      return { content: [{ type: "text" as const, text: `Goal created\nObjective: ${result.objective}\nDone when: ${result.doneWhen}` }], details: { goal: details(result) } };
    },
    renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("create_goal ")) + theme.fg("accent", truncate(args.objective, 60)), 0, 0); },
    renderResult: renderText,
  });

  pi.registerTool({
    name: "get_goal",
    label: "Get Goal",
    description: "Read the structured goal state, usage, limits, progress checkpoints, and evaluation claim.",
    promptSnippet: "Inspect goal state and progress",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      const goal = stateOrNull(ctx);
      if (!goal || goal.status === "cleared") return { content: [{ type: "text" as const, text: "No active goal." }], details: {} };
      return { content: [{ type: "text" as const, text: [`Objective: ${goal.objective}`, `Done when: ${goal.doneWhen}`, `Status: ${goal.status}`, `Usage: ${fmtCost(goal.usage.cost)} · ${goal.usage.turns} turns · ${elapsed(goal)}`, `Progress: ${goal.progress.checkpoints.length} checkpoints`, goal.stopReason ? `Stop reason: ${goal.stopReason}` : "", goal.blocker ? `Blocker: ${goal.blocker}` : ""].filter(Boolean).join("\n") }], details: { goal: details(goal) } };
    },
    renderCall(_args, theme) { return new Text(theme.fg("toolTitle", theme.bold("get_goal")), 0, 0); },
    renderResult: renderText,
  });

  pi.registerTool({
    name: "goal_checkpoint",
    label: "Goal Checkpoint",
    description: "Record the concrete action, observation, progress classification, and evidence for the current provider cycle.",
    promptSnippet: "Record observed goal progress",
    parameters: Type.Object({
      action: Type.String({ description: "Concrete action performed." }),
      observation: Type.String({ description: "What the action showed." }),
      progress: StringEnum(["made", "blocked", "none"] as const),
      evidence: Type.String({ description: "Command output, test result, or other concrete evidence." }),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const goal = stateOrNull(ctx);
      if (!goal?.activeRun) throw new Error("No active goal run.");
      const action = validateText(params.action, "action");
      const observation = validateText(params.observation, "observation");
      const evidence = validateText(params.evidence, "evidence", MAX_EVIDENCE);
      const next = await ensure(ctx).checkpoint(goal.activeRun.runId, { action, observation, progress: params.progress, evidence });
      if (runtimeRun) { runtimeRun.checkpointSeen = true; runtimeRun.lastProgress = params.progress; }
      const blocked = next.status === "blocked";
      if (blocked) {
        // The supervisor stopped the loop; finish the in-flight response without
        // aborting it. Release the lease so remaining work is ordinary and free.
        clearExecutionTimer();
        runtimeRun = null;
      }
      const text = blocked
        ? `Checkpoint recorded: ${params.progress}\nGoal blocked: ${next.blocker ?? "repeated cycles made no progress"}. Stop goal work; the user must resume or replace the goal.`
        : `Checkpoint recorded: ${params.progress}`;
      return { content: [{ type: "text" as const, text }], details: { checkpoint: next.progress.checkpoints.at(-1), goal: details(next) }, ...(blocked ? { terminate: true } : {}) };
    },
    renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("goal_checkpoint ")) + theme.fg("accent", args.progress), 0, 0); },
    renderResult: renderText,
  });

  pi.registerTool({
    name: "evaluate_goal",
    label: "Evaluate Goal",
    description: "Request or record an independent, read-only evaluation of the current goal revision.",
    promptSnippet: "Evaluate whether the goal is complete",
    parameters: Type.Object({
      requestId: Type.Optional(Type.String()),
      verdict: Type.Optional(StringEnum(["achieved", "not_yet", "error"] as const)),
      reason: Type.Optional(Type.String()),
      evidence: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const currentController = ensure(ctx);
      if (!params.verdict) {
        const request = await currentController.requestEvaluation();
        return { content: [{ type: "text" as const, text: `Evaluation request: ${request.requestId}\n\n${evaluationPrompt(request.promptState)}` }], details: { requestId: request.requestId, goal: details(request.promptState) } };
      }
      const requestId = validateText(params.requestId, "requestId", 128);
      const reason = validateText(params.reason, "reason");
      const evidence = params.evidence === undefined ? undefined : validateText(params.evidence, "evidence", MAX_EVIDENCE);
      const goal = await currentController.recordEvaluation({ requestId, verdict: params.verdict, reason, ...(evidence ? { evidence } : {}) });
      return { content: [{ type: "text" as const, text: `Evaluation recorded: ${params.verdict}` }], details: { evaluation: goal.evaluation, goal: details(goal) } };
    },
    renderCall(_args, theme) { return new Text(theme.fg("toolTitle", theme.bold("evaluate_goal")), 0, 0); },
    renderResult: renderText,
  });

  pi.registerTool({
    name: "update_goal",
    label: "Update Goal",
    description: "Complete or block a goal. Completion requires an achieved current evaluation; pause, resume, clear, and replacement are user commands.",
    promptSnippet: "Complete or block the active goal",
    promptGuidelines: ["Complete only after a fresh evaluator records achieved with concrete evidence.", "Block only when a concrete external dependency or user decision is required."],
    parameters: Type.Object({ status: StringEnum(["complete", "blocked"] as const), blocker: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _update, ctx) {
      const currentController = ensure(ctx);
      if (params.status === "complete") {
        const goal = await currentController.complete();
        return { content: [{ type: "text" as const, text: `Goal complete\nObjective: ${goal.objective}` }], details: { goal: details(goal) }, terminate: true };
      }
      const blocker = validateText(params.blocker, "blocker");
      const goal = await currentController.changeStatus("blocked", "requires user input or external dependency", blocker);
      return { content: [{ type: "text" as const, text: `Goal blocked\nBlocker: ${blocker}` }], details: { goal: details(goal) }, terminate: true };
    },
    renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("update_goal ")) + theme.fg(args.status === "complete" ? "success" : "warning", args.status), 0, 0); },
    renderResult: renderText,
  });

  function statusText(state: GoalState | null): string {
    if (!state || state.status === "cleared") return "No active goal.";
    return [`🎯 [${state.status}] ${state.objective}`, `Done when: ${state.doneWhen}`, `Usage: ${fmtCost(state.usage.cost)} · ${state.usage.turns} turns · execution ${elapsed(state)}`, `Progress: ${state.progress.checkpoints.length} checkpoints`, state.stopReason ? `Stop reason: ${state.stopReason}` : "", state.blocker ? `Blocker: ${state.blocker}` : ""].filter(Boolean).join("\n");
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
        compactionRecovery = null;
        await currentController.changeStatus("paused", "paused by user");
        ctx.ui.notify("Goal paused. The running response finishes; /goal resume continues the goal.", "info");
        return;
      }
      if (command === "resume") {
        startupPending = false;
        const state = currentController.state;
        if (!state || !["paused", "blocked"].includes(state.status)) throw new Error("Only a paused or blocked goal can be resumed; create a new goal with revised limits after a limit stop.");
        compactionRecovery = null;
        const resumed = await currentController.changeStatus("active", "resumed by user");
        if (!agentCycleActive) await currentController.requestContinuation(false, continuationPrompt(resumed, false));
        ctx.ui.notify(agentCycleActive ? "Goal resumed. The running response finishes first; the goal continues after it settles." : "Goal resumed.", "info");
        return;
      }
      if (["clear", "stop", "cancel"].includes(command ?? "")) {
        startupPending = false;
        const state = currentController.state;
        if (!state || state.status === "cleared") { ctx.ui.notify("No active goal.", "info"); return; }
        await releaseRuntime(ctx, currentController, "cleared by user");
        compactionRecovery = null;
        await currentController.clear("cleared by user");
        ctx.ui.notify("Goal cleared.", "info");
        return;
      }
      const objective = raw;
      startupPending = false;
      if (currentController.state && currentController.state.status !== "cleared") {
        await releaseRuntime(ctx, currentController, "replaced by a new goal");
        compactionRecovery = null;
      }
      const goal = await currentController.create({ objective, doneWhen: "The stated objective is verifiably satisfied.", limits: { maxCost: null, maxTurns: null, maxExecutionSeconds: null } });
      if (!agentCycleActive) await currentController.requestContinuation(false, continuationPrompt(goal, false));
      ctx.ui.notify(`Goal started: ${goal.objective}`, "info");
    },
  });
}
