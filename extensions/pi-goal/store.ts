import { randomUUID } from "node:crypto";
import { reduceGoal } from "./domain.ts";
import type { GoalEvent, GoalState } from "./domain.ts";

export const EVENT_ENTRY = "pi-goal/event";
export const SNAPSHOT_ENTRY = "pi-goal/snapshot";

export class GoalStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoalStoreError";
  }
}

interface EntryWriter {
  appendEntry(customType: string, data: unknown): void;
}

const MAX_TEXT = 4_000;
const MAX_EVENTS = 20_000;
const MAX_NUMBER = Number.MAX_SAFE_INTEGER;
const EVENT_TYPES = new Set([
  "created", "status_changed", "cleared", "activity_invalidated", "run_started", "run_ended", "turn_accounted", "execution_accounted",
  "checkpointed", "evaluation_requested", "evaluation_recorded", "dispatch_requested", "dispatch_acknowledged", "dispatch_failed", "dispatch_superseded",
]);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const clone = <T>(value: T): T => structuredClone(value);

function validString(value: unknown, max = MAX_TEXT): value is string {
  return typeof value === "string" && value.length <= max;
}

function validEvent(value: unknown, sessionId: string): value is GoalEvent {
  if (!isRecord(value) || value.schemaVersion !== 2 || value.kind !== "goal_event") return false;
  const seq = value.seq;
  const type = value.type;
  if (!validString(value.eventId, 128) || !validString(value.sessionId, MAX_TEXT) || value.sessionId !== sessionId || !validString(value.goalId, 128) || !validString(value.at, 128)) return false;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1 || seq > MAX_EVENTS || typeof type !== "string" || !EVENT_TYPES.has(type)) return false;
  if (type === "created") return validString(value.objective, MAX_TEXT) && validString(value.doneWhen, MAX_TEXT) && validLimits(value.limits);
  if (type === "status_changed") return ["active", "blocked", "limited", "paused", "complete"].includes(String(value.status)) && validString(value.reason) && (value.blocker === undefined || validString(value.blocker));
  if (type === "cleared" || type === "activity_invalidated") return validString(value.reason);
  if (type === "run_started") return validLease(value.lease);
  if (type === "run_ended") return validString(value.runId, 128);
  if (type === "turn_accounted") return validString(value.runId, 128) && validString(value.turnId, 256) && validNonNegativeNumbers(value.inputTokens, value.outputTokens, value.totalTokens, value.cost);
  if (type === "execution_accounted") return validString(value.runId, 128) && typeof value.seconds === "number" && Number.isSafeInteger(value.seconds) && value.seconds >= 0;
  if (type === "checkpointed") return isRecord(value.checkpoint) && validString(value.checkpoint.runId, 128) && validString(value.checkpoint.action) && validString(value.checkpoint.observation) && ["made", "blocked", "none"].includes(String(value.checkpoint.progress)) && validString(value.checkpoint.evidence, MAX_TEXT);
  if (type === "evaluation_requested") return validString(value.requestId, 128) && Number.isSafeInteger(value.revision) && Number.isSafeInteger(value.activityEpoch);
  if (type === "evaluation_recorded") return validString(value.requestId, 128) && Number.isSafeInteger(value.revision) && Number.isSafeInteger(value.activityEpoch) && ["achieved", "not_yet", "error"].includes(String(value.verdict)) && validString(value.reason) && (value.evidence === undefined || validString(value.evidence, MAX_TEXT));
  if (type === "dispatch_requested") return validString(value.dispatchId, 128) && validString(value.runId, 128) && Number.isSafeInteger(value.goalRevision) && typeof value.forceAction === "boolean";
  if (type === "dispatch_acknowledged" || type === "dispatch_failed" || type === "dispatch_superseded") return validString(value.dispatchId, 128) && (type === "dispatch_acknowledged" || validString(value.reason));
  return false;
}

function validNonNegativeNumbers(...values: unknown[]): boolean {
  return values.every(value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_NUMBER);
}

function validLimits(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (value.maxCost === null || (typeof value.maxCost === "number" && value.maxCost > 0 && value.maxCost <= MAX_NUMBER))
    && (value.maxTurns === null || (typeof value.maxTurns === "number" && Number.isSafeInteger(value.maxTurns) && value.maxTurns > 0 && value.maxTurns <= MAX_NUMBER))
    && (value.maxExecutionSeconds === null || (typeof value.maxExecutionSeconds === "number" && value.maxExecutionSeconds > 0 && value.maxExecutionSeconds <= MAX_NUMBER));
}

function validLease(value: unknown): boolean {
  return isRecord(value) && validString(value.runId, 128) && ["user", "continuation", "recovery"].includes(String(value.owner)) && typeof value.goalRevision === "number" && Number.isSafeInteger(value.goalRevision);
}

function validSnapshot(value: unknown, sessionId: string): value is { schemaVersion: 2; kind: "snapshot"; sessionId: string; at: string; state: GoalState } {
  if (!isRecord(value) || value.schemaVersion !== 2 || value.kind !== "snapshot" || value.sessionId !== sessionId || !validString(value.at, 128) || !isRecord(value.state)) return false;
  const state = value.state;
  const usage = state.usage;
  const progress = state.progress;
  const checkpoints = isRecord(progress) && Array.isArray(progress.checkpoints) ? progress.checkpoints : undefined;
  const activeRun = state.activeRun;
  const pendingDispatch = state.pendingDispatch;
  const evaluation = state.evaluation;
  return state.schemaVersion === 2
    && validString(state.id, 128)
    && state.sessionId === sessionId
    && validString(state.objective, MAX_TEXT)
    && validString(state.doneWhen, MAX_TEXT)
    && ["active", "paused", "blocked", "limited", "complete", "cleared"].includes(String(state.status))
    && typeof state.revision === "number" && Number.isSafeInteger(state.revision) && state.revision >= 0
    && typeof state.activityEpoch === "number" && Number.isSafeInteger(state.activityEpoch) && state.activityEpoch >= 0
    && typeof state.eventSeq === "number" && Number.isSafeInteger(state.eventSeq) && state.eventSeq >= 1
    && validString(state.createdAt, 128) && validString(state.updatedAt, 128)
    && validLimits(state.limits)
    && isRecord(usage)
    && validNonNegativeNumbers(usage.turns, usage.inputTokens, usage.outputTokens, usage.totalTokens, usage.cost, usage.executionSeconds)
    && isRecord(progress)
    && typeof progress.consecutiveNoProgress === "number" && Number.isSafeInteger(progress.consecutiveNoProgress) && progress.consecutiveNoProgress >= 0
    && typeof progress.consecutiveFailures === "number" && Number.isSafeInteger(progress.consecutiveFailures) && progress.consecutiveFailures >= 0
    && checkpoints !== undefined
    && checkpoints.length <= 100
    && checkpoints.every(checkpoint => isRecord(checkpoint) && typeof checkpoint.sequence === "number" && Number.isSafeInteger(checkpoint.sequence) && validString(checkpoint.runId, 128) && validString(checkpoint.action) && validString(checkpoint.observation) && ["made", "blocked", "none"].includes(String(checkpoint.progress)) && validString(checkpoint.evidence, MAX_TEXT) && validString(checkpoint.at, 128))
    && (activeRun === undefined || validLease(activeRun))
    && (pendingDispatch === undefined || (isRecord(pendingDispatch) && validString(pendingDispatch.dispatchId, 128) && validString(pendingDispatch.runId, 128) && typeof pendingDispatch.goalRevision === "number" && Number.isSafeInteger(pendingDispatch.goalRevision) && typeof pendingDispatch.forceAction === "boolean"))
    && (evaluation === undefined || isRecord(evaluation))
    && Array.isArray(state.accountedTurnIds)
    && state.accountedTurnIds.length <= MAX_EVENTS
    && state.accountedTurnIds.every(id => validString(id, 256));
}

export interface LoadedGoal {
  state: GoalState | null;
  events: number;
}

export function loadGoal(branch: readonly unknown[], sessionId: string): LoadedGoal {
  const goals = new Map<string, GoalState>();
  const eventIds = new Set<string>();
  let order = 0;
  const touched = new Map<string, number>();
  let events = 0;
  for (const entry of branch) {
    order += 1;
    if (!isRecord(entry) || entry.type !== "custom") continue;
    if (entry.customType === SNAPSHOT_ENTRY) {
      if (!validSnapshot(entry.data, sessionId)) throw new GoalStoreError("Invalid pi-goal snapshot entry.");
      const snapshot = entry.data.state;
      const current = goals.get(snapshot.id);
      if (!current || snapshot.eventSeq > current.eventSeq) {
        goals.set(snapshot.id, clone(snapshot));
        touched.set(snapshot.id, order);
      }
      continue;
    }
    if (entry.customType !== EVENT_ENTRY) continue;
    events += 1;
    if (events > MAX_EVENTS || !validEvent(entry.data, sessionId)) throw new GoalStoreError("Invalid pi-goal event entry.");
    const event = entry.data;
    if (eventIds.has(event.eventId)) continue;
    eventIds.add(event.eventId);
    const current = goals.get(event.goalId) ?? null;
    if (current && event.seq <= current.eventSeq) continue;
    try {
      const next = reduceGoal(current, event);
      if (!next) throw new GoalStoreError("Goal creation produced no state.");
      goals.set(event.goalId, next);
      touched.set(event.goalId, order);
    } catch (error) {
      throw new GoalStoreError(error instanceof Error ? error.message : "Could not replay pi-goal event.");
    }
  }
  const newest = [...touched.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
  return { state: newest ? clone(goals.get(newest)!) : null, events };
}

export class GoalStore {
  private state: GoalState | null;
  private eventCount: number;

  constructor(private readonly writer: EntryWriter, private readonly sessionId: string, branch: readonly unknown[]) {
    const loaded = loadGoal(branch, sessionId);
    this.state = loaded.state;
    this.eventCount = loaded.events;
  }

  get current(): GoalState | null {
    return this.state ? clone(this.state) : null;
  }

  append(goalId: string, type: GoalEvent["type"], payload: Record<string, unknown>, at: string): GoalState {
    if (this.eventCount >= MAX_EVENTS) throw new GoalStoreError("Goal event limit reached.");
    const current = this.state;
    if (type === "created") {
      if (current && current.status !== "cleared") throw new GoalStoreError("A goal already exists in this session branch.");
    } else if (!current || current.id !== goalId) {
      throw new GoalStoreError("No current goal for this event.");
    }
    const event = {
      schemaVersion: 2 as const,
      kind: "goal_event" as const,
      eventId: randomUUID(),
      seq: type === "created" ? 1 : current!.eventSeq + 1,
      sessionId: this.sessionId,
      goalId,
      at,
      type,
      ...clone(payload),
    } as unknown as GoalEvent;
    let next: GoalState | null;
    try {
      next = reduceGoal(type === "created" ? null : current, event);
    } catch (error) {
      throw new GoalStoreError(error instanceof Error ? error.message : "Invalid goal transition.");
    }
    if (!next) throw new GoalStoreError("Goal transition produced no state.");
    this.writer.appendEntry(EVENT_ENTRY, event);
    this.state = next;
    this.eventCount += 1;
    return clone(next);
  }

  snapshot(at: string): void {
    if (!this.state) return;
    this.writer.appendEntry(SNAPSHOT_ENTRY, { schemaVersion: 2, kind: "snapshot", sessionId: this.sessionId, at, state: clone(this.state) });
  }
}

export function validateLimits(limits: GoalState["limits"]): void {
  for (const value of [limits.maxCost, limits.maxExecutionSeconds]) {
    if (value !== null && (!isFiniteNumber(value) || value <= 0 || value > MAX_NUMBER)) throw new GoalStoreError("Limits must be finite, positive numbers.");
  }
  if (limits.maxTurns !== null && (!Number.isSafeInteger(limits.maxTurns) || limits.maxTurns <= 0 || limits.maxTurns > MAX_NUMBER)) throw new GoalStoreError("maxTurns must be a positive safe integer.");
}
