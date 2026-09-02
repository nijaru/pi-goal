import { randomUUID } from "node:crypto";
import { reduceGoal } from "./domain.ts";
import type { GoalEvent, GoalState } from "./domain.ts";

export const EVENT_ENTRY = "pi-goal/event";
export const SNAPSHOT_ENTRY = "pi-goal/snapshot";
const SCHEMA_VERSION = 3;

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
  "created", "status_changed", "cleared", "run_started", "run_ended", "turn_accounted", "execution_accounted",
  "dispatch_requested", "dispatch_acknowledged", "dispatch_failed", "dispatch_superseded",
]);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const clone = <T>(value: T): T => structuredClone(value);
const validString = (value: unknown, max = MAX_TEXT): value is string => typeof value === "string" && value.length <= max;
const validNonNegativeNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_NUMBER;

function validEvent(value: unknown, sessionId: string): value is GoalEvent {
  if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION || value.kind !== "goal_event") return false;
  if (!validString(value.eventId, 128) || !validString(value.sessionId, MAX_TEXT) || value.sessionId !== sessionId || !validString(value.goalId, 128) || !validString(value.at, 128)) return false;
  if (typeof value.seq !== "number" || !Number.isSafeInteger(value.seq) || value.seq < 1 || value.seq > MAX_EVENTS || typeof value.type !== "string" || !EVENT_TYPES.has(value.type)) return false;
  if (value.type === "created") return validString(value.objective, MAX_TEXT);
  if (value.type === "status_changed") return ["active", "paused", "blocked", "complete"].includes(String(value.status)) && validString(value.reason) && (value.blocker === undefined || validString(value.blocker));
  if (value.type === "cleared") return validString(value.reason);
  if (value.type === "run_started") return validLease(value.lease);
  if (value.type === "run_ended") return validString(value.runId, 128);
  if (value.type === "turn_accounted") return validString(value.runId, 128) && validString(value.turnId, 256) && [value.inputTokens, value.outputTokens, value.totalTokens, value.cost].every(validNonNegativeNumber);
  if (value.type === "execution_accounted") return validString(value.runId, 128) && typeof value.seconds === "number" && Number.isSafeInteger(value.seconds) && value.seconds >= 0;
  if (value.type === "dispatch_requested") return validString(value.dispatchId, 128) && validString(value.runId, 128);
  if (value.type === "dispatch_acknowledged" || value.type === "dispatch_failed" || value.type === "dispatch_superseded") return validString(value.dispatchId, 128) && (value.type === "dispatch_acknowledged" || validString(value.reason));
  return false;
}

function validLease(value: unknown): boolean {
  return isRecord(value) && validString(value.runId, 128) && ["user", "continuation", "recovery"].includes(String(value.owner));
}

function validSnapshot(value: unknown, sessionId: string): value is { schemaVersion: 3; kind: "snapshot"; sessionId: string; at: string; state: GoalState } {
  if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION || value.kind !== "snapshot" || value.sessionId !== sessionId || !validString(value.at, 128) || !isRecord(value.state)) return false;
  const state = value.state;
  const usage = state.usage;
  const activeRun = state.activeRun;
  const pendingDispatch = state.pendingDispatch;
  return state.schemaVersion === SCHEMA_VERSION
    && validString(state.id, 128)
    && state.sessionId === sessionId
    && validString(state.objective, MAX_TEXT)
    && ["active", "paused", "blocked", "complete", "cleared"].includes(String(state.status))
    && typeof state.eventSeq === "number" && Number.isSafeInteger(state.eventSeq) && state.eventSeq >= 1
    && validString(state.createdAt, 128) && validString(state.updatedAt, 128)
    && isRecord(usage)
    && [usage.turns, usage.inputTokens, usage.outputTokens, usage.totalTokens, usage.cost, usage.executionSeconds].every(validNonNegativeNumber)
    && (activeRun === undefined || validLease(activeRun))
    && (pendingDispatch === undefined || (isRecord(pendingDispatch) && validString(pendingDispatch.dispatchId, 128) && validString(pendingDispatch.runId, 128)))
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
  const touched = new Map<string, number>();
  let order = 0;
  let events = 0;
  for (const entry of branch) {
    order += 1;
    if (!isRecord(entry) || entry.type !== "custom") continue;
    if (entry.customType === SNAPSHOT_ENTRY) {
      if (!isRecord(entry.data) || entry.data.schemaVersion !== SCHEMA_VERSION) continue;
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
    if (!isRecord(entry.data) || entry.data.schemaVersion !== SCHEMA_VERSION) continue;
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
      schemaVersion: SCHEMA_VERSION,
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
    this.writer.appendEntry(SNAPSHOT_ENTRY, { schemaVersion: SCHEMA_VERSION, kind: "snapshot", sessionId: this.sessionId, at, state: clone(this.state) });
  }
}
