import { randomUUID } from "node:crypto";
import type { GoalEvent, GoalState, RunOwner, Usage } from "./domain.ts";
import { GoalStore } from "./store.ts";

export interface ControllerHost {
  sendContinuation(message: { dispatchId: string; goalId: string; runId: string; content: string }): void;
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

  create(input: { id?: string; objective: string }): Promise<GoalState> {
    return this.enqueue(() => {
      const current = this.store.current;
      if (current && !["cleared", "complete"].includes(current.status)) {
        throw new Error("This thread already has an unfinished goal; complete or clear it before creating another.");
      }
      if (current?.status === "complete") this.commit(current.id, "cleared", { reason: "replaced after completion" });
      const goalId = input.id ?? randomUUID();
      return this.commit(goalId, "created", { objective: input.objective });
    });
  }

  changeStatus(status: "active" | "paused" | "blocked" | "complete", reason: string, blocker?: string): Promise<GoalState> {
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

  startRun(owner: RunOwner, runId: string = randomUUID()): Promise<GoalState> {
    return this.enqueue(() => {
      const state = this.requireState();
      const lease = { runId, owner };
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
      return this.commit(state.id, "turn_accounted", {
        runId,
        turnId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        cost: usage.cost,
      });
    });
  }

  accountExecution(runId: string, seconds: number): Promise<GoalState> {
    return this.enqueue(() => {
      const state = this.requireState();
      return this.commit(state.id, "execution_accounted", { runId, seconds });
    });
  }

  requestContinuation(content: string): Promise<{ dispatchId: string; runId: string }> {
    return this.enqueue(() => {
      const state = this.requireState();
      if (state.status !== "active") throw new Error(`Goal is ${state.status}.`);
      if (state.activeRun) throw new Error("A goal run is already active.");
      if (state.pendingDispatch) throw new Error("A continuation is already pending.");
      const dispatchId = randomUUID();
      const runId = randomUUID();
      this.commit(state.id, "dispatch_requested", { dispatchId, runId });
      try {
        this.host.sendContinuation({ dispatchId, goalId: state.id, runId, content });
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
      return this.commit(state.id, "run_started", { lease: { runId: dispatch.runId, owner: "continuation" } });
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
