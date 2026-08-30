import { randomUUID } from "node:crypto";
import { canComplete } from "./domain.ts";
import type { GoalEvent, GoalState, ProgressKind, RunOwner, Usage } from "./domain.ts";
import { GoalStore } from "./store.ts";

export interface ControllerHost {
  abort(): void;
  sendContinuation(message: { dispatchId: string; goalId: string; runId: string; forceAction: boolean; content: string }): void;
  stateChanged(state: GoalState | null): void;
}

export class GoalController {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => string;

  constructor(
    private readonly store: GoalStore,
    private readonly host: ControllerHost,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.now = now;
  }

  get state(): GoalState | null {
    return this.store.current;
  }

  snapshot(at = this.now()): void {
    this.store.snapshot(at);
  }

  enqueue<T>(work: () => T | PromiseLike<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  private commit<T extends GoalEvent["type"]>(goalId: string, type: T, payload: Record<string, unknown>): GoalState {
    const state = this.store.append(goalId, type, payload as never, this.now());
    this.host.stateChanged(state);
    return state;
  }

  create(input: { id?: string; objective: string; doneWhen: string; limits: GoalState["limits"] }): Promise<GoalState> {
    return this.enqueue(() => {
      const current = this.store.current;
      if (current && current.status !== "cleared") this.commit(current.id, "cleared", { reason: "replaced by a new goal" });
      const goalId = input.id ?? randomUUID();
      return this.commit(goalId, "created", {
        objective: input.objective,
        doneWhen: input.doneWhen,
        limits: input.limits,
      });
    });
  }

  changeStatus(status: "active" | "paused" | "blocked" | "limited" | "complete", reason: string, blocker?: string): Promise<GoalState> {
    return this.enqueue(() => {
      const state = this.requireState();
      return this.commit(state.id, "status_changed", { status, reason, ...(blocker ? { blocker } : {}) });
    });
  }

  clear(reason: string): Promise<GoalState> {
    return this.enqueue(() => {
      const state = this.requireState();
      return this.commit(state.id, "cleared", { reason });
    });
  }

  invalidateActivity(reason: string): Promise<GoalState | null> {
    return this.enqueue(() => {
      const state = this.store.current;
      if (!state || state.status !== "active") return state;
      return this.commit(state.id, "activity_invalidated", { reason });
    });
  }

  startRun(owner: RunOwner, runId: string = randomUUID()): Promise<GoalState> {
    return this.enqueue(() => {
      const state = this.requireState();
      if ((state.limits.maxCost !== null && state.usage.cost >= state.limits.maxCost)
        || (state.limits.maxTurns !== null && state.usage.turns >= state.limits.maxTurns)
        || (state.limits.maxExecutionSeconds !== null && state.usage.executionSeconds >= state.limits.maxExecutionSeconds)) {
        throw new Error("Goal limit reached; create a replacement with revised limits.");
      }
      const lease = { runId, owner, goalRevision: state.revision };
      return this.commit(state.id, "run_started", { lease });
    });
  }

  endRun(runId: string): Promise<GoalState | null> {
    return this.enqueue(() => {
      const state = this.store.current;
      if (!state || state.activeRun?.runId !== runId) return state;
      return this.commit(state.id, "run_ended", { runId });
    });
  }

  accountTurn(runId: string, turnId: string, usage: Usage): Promise<GoalState> {
    return this.enqueue(() => {
      const state = this.requireState();
      const next = this.commit(state.id, "turn_accounted", {
        runId,
        turnId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        cost: usage.cost,
      });
      if (next.status === "limited") this.host.abort();
      return next;
    });
  }

  accountExecution(runId: string, seconds: number): Promise<GoalState> {
    return this.enqueue(() => {
      const state = this.requireState();
      const next = this.commit(state.id, "execution_accounted", { runId, seconds });
      if (next.status === "limited") this.host.abort();
      return next;
    });
  }

  checkpoint(runId: string, input: { action: string; observation: string; progress: ProgressKind; evidence: string }): Promise<GoalState> {
    return this.enqueue(() => {
      const state = this.requireState();
      const next = this.commit(state.id, "checkpointed", { checkpoint: { runId, ...input } });
      if (next.status === "blocked") this.host.abort();
      return next;
    });
  }

  requestEvaluation(): Promise<{ requestId: string; promptState: GoalState }> {
    return this.enqueue(() => {
      const state = this.requireState();
      const requestId = randomUUID();
      const next = this.commit(state.id, "evaluation_requested", { requestId, revision: state.revision, activityEpoch: state.activityEpoch });
      return { requestId, promptState: next };
    });
  }

  recordEvaluation(input: { requestId: string; verdict: "achieved" | "not_yet" | "error"; reason: string; evidence?: string }): Promise<GoalState> {
    return this.enqueue(() => {
      const state = this.requireState();
      return this.commit(state.id, "evaluation_recorded", {
        ...input,
        revision: state.revision,
        activityEpoch: state.activityEpoch,
      });
    });
  }

  complete(): Promise<GoalState> {
    return this.enqueue(() => {
      const state = this.requireState();
      if (!canComplete(state)) throw new Error("Completion requires an achieved evaluation for the current revision and activity epoch.");
      return this.commit(state.id, "status_changed", { status: "complete", reason: "completion condition achieved" });
    });
  }

  requestContinuation(forceAction: boolean, content: string): Promise<{ dispatchId: string; runId: string }> {
    return this.enqueue(() => {
      const state = this.requireState();
      if (state.status !== "active") throw new Error(`Goal is ${state.status}.`);
      if (state.pendingDispatch) throw new Error("A continuation is already pending.");
      const dispatchId = randomUUID();
      const runId = randomUUID();
      this.commit(state.id, "dispatch_requested", { dispatchId, runId, goalRevision: state.revision, forceAction });
      try {
        this.host.sendContinuation({ dispatchId, goalId: state.id, runId, forceAction, content });
      } catch (error) {
        this.commit(state.id, "dispatch_failed", { dispatchId, reason: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      return { dispatchId, runId };
    });
  }

  acknowledgeContinuation(dispatchId: string): Promise<GoalState> {
    return this.enqueue(() => {
      const state = this.requireState();
      if (state.pendingDispatch?.dispatchId !== dispatchId) throw new Error("Stale continuation acknowledgement.");
      const dispatch = state.pendingDispatch;
      this.commit(state.id, "dispatch_acknowledged", { dispatchId });
      return this.commit(state.id, "run_started", { lease: { runId: dispatch.runId, owner: "continuation", goalRevision: state.revision } });
    });
  }

  failContinuation(dispatchId: string, reason: string): Promise<GoalState> {
    return this.enqueue(() => {
      const state = this.requireState();
      return this.commit(state.id, "dispatch_failed", { dispatchId, reason });
    });
  }

  supersedeContinuation(dispatchId: string, reason: string): Promise<GoalState> {
    return this.enqueue(() => {
      const state = this.requireState();
      return this.commit(state.id, "dispatch_superseded", { dispatchId, reason });
    });
  }

  private requireState(): GoalState {
    const state = this.store.current;
    if (!state) throw new Error("No active goal.");
    return state;
  }
}
