export type GoalStatus = "active" | "paused" | "blocked" | "limited" | "complete" | "cleared";
export type ProgressKind = "made" | "blocked" | "none";
export type EvaluationVerdict = "achieved" | "not_yet" | "error";
export type RunOwner = "user" | "continuation" | "recovery";

export interface Limits {
  maxCost: number | null;
  maxTurns: number | null;
  maxExecutionSeconds: number | null;
}

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
  goalRevision: number;
}

export interface ProgressCheckpoint {
  sequence: number;
  runId: string;
  action: string;
  observation: string;
  progress: ProgressKind;
  evidence: string;
  at: string;
}

export interface ProgressState {
  checkpoints: ProgressCheckpoint[];
  consecutiveNoProgress: number;
  consecutiveFailures: number;
}

export interface EvaluationClaim {
  requestId: string;
  revision: number;
  activityEpoch: number;
  verdict?: EvaluationVerdict;
  reason?: string;
  evidence?: string;
  at: string;
}

export interface GoalState {
  schemaVersion: 2;
  id: string;
  sessionId: string;
  objective: string;
  doneWhen: string;
  status: GoalStatus;
  revision: number;
  activityEpoch: number;
  limits: Limits;
  usage: Usage;
  progress: ProgressState;
  activeRun?: RunLease;
  pendingDispatch?: { dispatchId: string; runId: string; goalRevision: number; forceAction: boolean };
  evaluation?: EvaluationClaim;
  blocker?: string;
  stopReason?: string;
  createdAt: string;
  updatedAt: string;
  eventSeq: number;
  accountedTurnIds: string[];
}

export interface EventBase {
  schemaVersion: 2;
  kind: "goal_event";
  eventId: string;
  seq: number;
  sessionId: string;
  goalId: string;
  at: string;
}

export type GoalEvent = EventBase & (
  | { type: "created"; objective: string; doneWhen: string; limits: Limits }
  | { type: "status_changed"; status: Exclude<GoalStatus, "cleared">; reason: string; blocker?: string }
  | { type: "cleared"; reason: string }
  | { type: "activity_invalidated"; reason: string }
  | { type: "run_started"; lease: RunLease }
  | { type: "run_ended"; runId: string }
  | { type: "turn_accounted"; runId: string; turnId: string; inputTokens: number; outputTokens: number; totalTokens: number; cost: number }
  | { type: "execution_accounted"; runId: string; seconds: number }
  | { type: "checkpointed"; checkpoint: Omit<ProgressCheckpoint, "sequence" | "at"> }
  | { type: "evaluation_requested"; requestId: string; revision: number; activityEpoch: number }
  | { type: "evaluation_recorded"; requestId: string; revision: number; activityEpoch: number; verdict: EvaluationVerdict; reason: string; evidence?: string }
  | { type: "dispatch_requested"; dispatchId: string; runId: string; goalRevision: number; forceAction: boolean }
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

const MAX_CHECKPOINTS = 100;
const MAX_NO_PROGRESS = 3;
const MAX_FAILURES = 3;

const clone = <T>(value: T): T => structuredClone(value);

function active(state: GoalState): void {
  if (state.status !== "active") throw new GoalTransitionError(`Goal is ${state.status}.`);
}

function sameRun(state: GoalState, runId: string): void {
  if (state.activeRun?.runId !== runId) throw new GoalTransitionError("Stale or unknown run lease.");
}

function bumpRevision(state: GoalState): void {
  state.revision += 1;
  state.evaluation = undefined;
  state.activityEpoch += 1;
}

function checkLimit(state: GoalState): void {
  const { limits, usage } = state;
  if (limits.maxCost !== null && usage.cost >= limits.maxCost) {
    state.status = "limited";
    state.stopReason = "USD budget exhausted";
  } else if (limits.maxTurns !== null && usage.turns >= limits.maxTurns) {
    state.status = "limited";
    state.stopReason = "turn limit reached";
  } else if (limits.maxExecutionSeconds !== null && usage.executionSeconds >= limits.maxExecutionSeconds) {
    state.status = "limited";
    state.stopReason = "execution-time limit reached";
  }
}

export function createGoalState(input: {
  id: string;
  sessionId: string;
  objective: string;
  doneWhen: string;
  limits: Limits;
  at: string;
}): GoalState {
  if (!input.objective.trim()) throw new GoalTransitionError("Objective is required.");
  if (!input.doneWhen.trim()) throw new GoalTransitionError("Definition of done is required.");
  return {
    schemaVersion: 2,
    id: input.id,
    sessionId: input.sessionId,
    objective: input.objective.trim(),
    doneWhen: input.doneWhen.trim(),
    status: "active",
    revision: 0,
    activityEpoch: 0,
    limits: clone(input.limits),
    usage: { turns: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, executionSeconds: 0 },
    progress: { checkpoints: [], consecutiveNoProgress: 0, consecutiveFailures: 0 },
    createdAt: input.at,
    updatedAt: input.at,
    eventSeq: 1,
    accountedTurnIds: [],
  };
}

export function reduceGoal(state: GoalState | null, event: GoalEvent): GoalState | null {
  if (!state) {
    if (event.type !== "created") throw new GoalTransitionError("Goal must be created before other events.");
    const created = createGoalState({ id: event.goalId, sessionId: event.sessionId, objective: event.objective, doneWhen: event.doneWhen, limits: event.limits, at: event.at });
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
      if (event.status === "active" && !["paused", "blocked"].includes(state.status)) throw new GoalTransitionError(`Cannot resume a ${state.status} goal; create a new goal with revised limits.`);
      if (event.status !== "active" && state.status !== "active") throw new GoalTransitionError(`Cannot change ${state.status} goal status.`);
      if (event.status === "complete" && !canComplete(state)) throw new GoalTransitionError("Completion requires an achieved evaluation with evidence for the current revision.");
      next.status = event.status;
      next.blocker = event.blocker;
      next.stopReason = event.reason;
      if (event.status !== "active") {
        next.activeRun = undefined;
        next.pendingDispatch = undefined;
      }
      bumpRevision(next);
      return next;
    case "cleared":
      if (state.status === "cleared") return next;
      next.status = "cleared";
      next.stopReason = event.reason;
      next.activeRun = undefined;
      next.pendingDispatch = undefined;
      return next;
    case "activity_invalidated":
      bumpRevision(next);
      next.pendingDispatch = undefined;
      next.stopReason = event.reason;
      return next;
    case "run_started":
      active(next);
      if (next.activeRun) throw new GoalTransitionError("A goal run is already active.");
      if (event.lease.goalRevision !== next.revision) throw new GoalTransitionError("Run lease revision is stale.");
      next.activeRun = clone(event.lease);
      return next;
    case "run_ended":
      sameRun(next, event.runId);
      next.activeRun = undefined;
      return next;
    case "turn_accounted":
      sameRun(next, event.runId);
      if (next.accountedTurnIds.includes(event.turnId)) return next;
      if (next.usage.turns > 0 && next.usage.totalTokens < 0) throw new GoalTransitionError("Invalid usage state.");
      next.accountedTurnIds = [...next.accountedTurnIds, event.turnId];
      next.usage.turns += 1;
      next.usage.inputTokens += event.inputTokens;
      next.usage.outputTokens += event.outputTokens;
      next.usage.totalTokens += event.totalTokens;
      next.usage.cost += event.cost;
      checkLimit(next);
      return next;
    case "execution_accounted":
      sameRun(next, event.runId);
      if (!Number.isSafeInteger(event.seconds) || event.seconds < 0) throw new GoalTransitionError("Execution time must be a non-negative safe integer.");
      next.usage.executionSeconds += event.seconds;
      checkLimit(next);
      return next;
    case "checkpointed": {
      sameRun(next, event.checkpoint.runId);
      const checkpoint: ProgressCheckpoint = { ...clone(event.checkpoint), sequence: (next.progress.checkpoints.at(-1)?.sequence ?? 0) + 1, at: event.at };
      next.progress.checkpoints = [...next.progress.checkpoints, checkpoint].slice(-MAX_CHECKPOINTS);
      next.progress.consecutiveNoProgress = event.checkpoint.progress === "made" ? 0 : next.progress.consecutiveNoProgress + 1;
      next.progress.consecutiveFailures = event.checkpoint.progress === "blocked" ? next.progress.consecutiveFailures + 1 : 0;
      if (next.progress.consecutiveNoProgress >= MAX_NO_PROGRESS || next.progress.consecutiveFailures >= MAX_FAILURES) {
        next.status = "blocked";
        next.blocker = event.checkpoint.observation;
        next.stopReason = "repeated cycles made no progress";
        next.activeRun = undefined;
      }
      return next;
    }
    case "evaluation_requested":
      active(next);
      if (event.revision !== next.revision || event.activityEpoch !== next.activityEpoch) throw new GoalTransitionError("Evaluation request is stale.");
      next.evaluation = { requestId: event.requestId, revision: event.revision, activityEpoch: event.activityEpoch, at: event.at };
      return next;
    case "evaluation_recorded":
      active(next);
      if (!next.evaluation || next.evaluation.requestId !== event.requestId || event.revision !== next.revision || event.activityEpoch !== next.activityEpoch) throw new GoalTransitionError("Evaluation claim is stale or was not requested.");
      if (event.verdict === "achieved" && !event.evidence?.trim()) throw new GoalTransitionError("Achieved evaluation requires evidence.");
      next.evaluation = { requestId: event.requestId, revision: event.revision, activityEpoch: event.activityEpoch, verdict: event.verdict, reason: event.reason, ...(event.evidence ? { evidence: event.evidence } : {}), at: event.at };
      return next;
    case "dispatch_requested":
      active(next);
      if (next.pendingDispatch) throw new GoalTransitionError("A continuation is already pending.");
      if (event.goalRevision !== next.revision) throw new GoalTransitionError("Continuation request is stale.");
      next.pendingDispatch = { dispatchId: event.dispatchId, runId: event.runId, goalRevision: event.goalRevision, forceAction: event.forceAction };
      return next;
    case "dispatch_acknowledged":
      if (next.pendingDispatch?.dispatchId !== event.dispatchId || next.pendingDispatch.goalRevision !== next.revision) throw new GoalTransitionError("Dispatch acknowledgement is stale.");
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

export function canComplete(state: GoalState): boolean {
  return state.status === "active"
    && state.evaluation?.verdict === "achieved"
    && state.evaluation.revision === state.revision
    && state.evaluation.activityEpoch === state.activityEpoch
    && Boolean(state.evaluation.evidence?.trim());
}
