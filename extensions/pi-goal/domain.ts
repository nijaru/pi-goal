export type GoalStatus = "active" | "paused" | "blocked" | "complete" | "cleared";
export type RunOwner = "user" | "continuation" | "recovery";

export interface Usage {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  executionSeconds: number;
}

export interface RunLease {
  runId: string;
  owner: RunOwner;
}

export interface GoalState {
  schemaVersion: 3;
  id: string;
  sessionId: string;
  objective: string;
  status: GoalStatus;
  usage: Usage;
  activeRun?: RunLease;
  pendingDispatch?: { dispatchId: string; runId: string };
  blocker?: string;
  stopReason?: string;
  createdAt: string;
  updatedAt: string;
  eventSeq: number;
  accountedTurnIds: string[];
}

export interface EventBase {
  schemaVersion: 3;
  kind: "goal_event";
  eventId: string;
  seq: number;
  sessionId: string;
  goalId: string;
  at: string;
}

export type GoalEvent = EventBase & (
  | { type: "created"; objective: string }
  | { type: "status_changed"; status: Exclude<GoalStatus, "cleared">; reason: string; blocker?: string }
  | { type: "cleared"; reason: string }
  | { type: "run_started"; lease: RunLease }
  | { type: "run_ended"; runId: string }
  | { type: "turn_accounted"; runId: string; turnId: string; inputTokens: number; outputTokens: number; totalTokens: number; cost: number }
  | { type: "execution_accounted"; runId: string; seconds: number }
  | { type: "dispatch_requested"; dispatchId: string; runId: string }
  | { type: "dispatch_acknowledged"; dispatchId: string }
  | { type: "dispatch_failed"; dispatchId: string; reason: string }
  | { type: "dispatch_superseded"; dispatchId: string; reason: string }
);

export class GoalTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoalTransitionError";
  }
}

const clone = <T>(value: T): T => structuredClone(value);

function active(state: GoalState): void {
  if (state.status !== "active") throw new GoalTransitionError(`Goal is ${state.status}.`);
}

function sameRun(state: GoalState, runId: string): void {
  if (state.activeRun?.runId !== runId) throw new GoalTransitionError("Stale or unknown run lease.");
}

export function createGoalState(input: {
  id: string;
  sessionId: string;
  objective: string;
  at: string;
}): GoalState {
  if (!input.objective.trim()) throw new GoalTransitionError("Objective is required.");
  return {
    schemaVersion: 3,
    id: input.id,
    sessionId: input.sessionId,
    objective: input.objective.trim(),
    status: "active",
    usage: { turns: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, executionSeconds: 0 },
    createdAt: input.at,
    updatedAt: input.at,
    eventSeq: 1,
    accountedTurnIds: [],
  };
}

export function reduceGoal(state: GoalState | null, event: GoalEvent): GoalState | null {
  if (!state) {
    if (event.type !== "created") throw new GoalTransitionError("Goal must be created before other events.");
    const created = createGoalState({ id: event.goalId, sessionId: event.sessionId, objective: event.objective, at: event.at });
    created.eventSeq = event.seq;
    return created;
  }
  if (event.goalId !== state.id || event.sessionId !== state.sessionId) throw new GoalTransitionError("Event belongs to another goal or session.");
  if (event.seq !== state.eventSeq + 1) throw new GoalTransitionError(`Expected event sequence ${state.eventSeq + 1}, got ${event.seq}.`);
  const next = clone(state);
  next.eventSeq = event.seq;
  next.updatedAt = event.at;

  switch (event.type) {
    case "created":
      throw new GoalTransitionError("Goal is already created.");
    case "status_changed":
      if (event.status === "active" && !["paused", "blocked"].includes(state.status)) {
        throw new GoalTransitionError(`Cannot resume a ${state.status} goal.`);
      }
      if (event.status !== "active" && state.status !== "active") {
        throw new GoalTransitionError(`Cannot change ${state.status} goal status.`);
      }
      next.status = event.status;
      next.blocker = event.blocker;
      next.stopReason = event.reason;
      if (event.status !== "active") {
        next.activeRun = undefined;
        next.pendingDispatch = undefined;
      }
      return next;
    case "cleared":
      if (state.status === "cleared") return next;
      next.status = "cleared";
      next.stopReason = event.reason;
      next.activeRun = undefined;
      next.pendingDispatch = undefined;
      return next;
    case "run_started":
      active(next);
      if (next.activeRun) throw new GoalTransitionError("A goal run is already active.");
      next.activeRun = clone(event.lease);
      return next;
    case "run_ended":
      sameRun(next, event.runId);
      next.activeRun = undefined;
      return next;
    case "turn_accounted":
      sameRun(next, event.runId);
      if (next.accountedTurnIds.includes(event.turnId)) return next;
      next.accountedTurnIds = [...next.accountedTurnIds, event.turnId];
      next.usage.turns += 1;
      next.usage.inputTokens += event.inputTokens;
      next.usage.outputTokens += event.outputTokens;
      next.usage.totalTokens += event.totalTokens;
      next.usage.cost += event.cost;
      return next;
    case "execution_accounted":
      sameRun(next, event.runId);
      if (!Number.isSafeInteger(event.seconds) || event.seconds < 0) throw new GoalTransitionError("Execution time must be a non-negative safe integer.");
      next.usage.executionSeconds += event.seconds;
      return next;
    case "dispatch_requested":
      active(next);
      if (next.pendingDispatch) throw new GoalTransitionError("A continuation is already pending.");
      next.pendingDispatch = { dispatchId: event.dispatchId, runId: event.runId };
      return next;
    case "dispatch_acknowledged":
      if (next.pendingDispatch?.dispatchId !== event.dispatchId) throw new GoalTransitionError("Dispatch acknowledgement is stale.");
      next.pendingDispatch = undefined;
      return next;
    case "dispatch_failed":
      if (next.pendingDispatch?.dispatchId !== event.dispatchId) throw new GoalTransitionError("Dispatch failure is stale.");
      next.pendingDispatch = undefined;
      next.status = "blocked";
      next.blocker = event.reason;
      next.stopReason = "continuation delivery failed";
      next.activeRun = undefined;
      return next;
    case "dispatch_superseded":
      if (next.pendingDispatch?.dispatchId !== event.dispatchId) throw new GoalTransitionError("Dispatch supersession is stale.");
      next.pendingDispatch = undefined;
      next.stopReason = event.reason;
      return next;
  }
}
