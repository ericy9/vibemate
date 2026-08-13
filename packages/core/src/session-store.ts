import {
  createSessionKey,
  type AgentEvent,
  type SessionIdentity,
  type UnifiedState,
} from "@vibemate/protocol";

export interface SessionSnapshot extends SessionIdentity {
  key: string;
  state: UnifiedState;
  updatedAt: string;
  recentEvents: AgentEvent[];
}

export type ApplyEventOutcome =
  | { result: "applied"; session: SessionSnapshot }
  | { result: "duplicate_event"; session: SessionSnapshot }
  | { result: "duplicate_completion"; session: SessionSnapshot }
  | { result: "stale"; session: SessionSnapshot };

interface SessionRecord extends SessionSnapshot {
  stateOccurredAtMs: number;
  stateEventId: string;
  completedTurns: Set<string>;
  completedTurnOrder: string[];
}

export interface SessionStoreOptions {
  maxRecentEvents?: number;
  maxSeenEventIds?: number;
  maxCompletedTurnsPerSession?: number;
}

function compareEvents(left: AgentEvent, right: AgentEvent): number {
  const timeDifference = Date.parse(left.occurredAt) - Date.parse(right.occurredAt);
  return timeDifference || left.eventId.localeCompare(right.eventId);
}

function compareEventToState(event: AgentEvent, record: SessionRecord): number {
  const timeDifference = Date.parse(event.occurredAt) - record.stateOccurredAtMs;
  return timeDifference || event.eventId.localeCompare(record.stateEventId);
}

function cloneSnapshot(record: SessionRecord): SessionSnapshot {
  return {
    key: record.key,
    sourceProfile: record.sourceProfile,
    agent: record.agent,
    sessionId: record.sessionId,
    state: record.state,
    updatedAt: record.updatedAt,
    recentEvents: structuredClone(record.recentEvents),
  };
}

export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly seenEventIds = new Set<string>();
  private readonly seenEventOrder: string[] = [];
  private readonly maxRecentEvents: number;
  private readonly maxSeenEventIds: number;
  private readonly maxCompletedTurnsPerSession: number;

  constructor(options: SessionStoreOptions = {}) {
    this.maxRecentEvents = options.maxRecentEvents ?? 50;
    this.maxSeenEventIds = options.maxSeenEventIds ?? 10_000;
    this.maxCompletedTurnsPerSession = options.maxCompletedTurnsPerSession ?? 256;
  }

  apply(event: AgentEvent): ApplyEventOutcome {
    const key = createSessionKey(event);
    let record = this.sessions.get(key);
    const dedupeKey = `${key}\u0000${event.eventId}`;
    if (this.seenEventIds.has(dedupeKey)) {
      if (!record) {
        throw new Error("event deduplication state is inconsistent");
      }
      return { result: "duplicate_event", session: cloneSnapshot(record) };
    }
    this.rememberEventId(dedupeKey);

    if (
      record
      && event.state === "completed"
      && event.turnId
      && record.completedTurns.has(event.turnId)
    ) {
      return { result: "duplicate_completion", session: cloneSnapshot(record) };
    }

    if (!record) {
      record = {
        key,
        sourceProfile: event.sourceProfile,
        agent: event.agent,
        sessionId: event.sessionId,
        state: event.state,
        updatedAt: event.occurredAt,
        stateOccurredAtMs: Date.parse(event.occurredAt),
        stateEventId: event.eventId,
        recentEvents: [structuredClone(event)],
        completedTurns: new Set(),
        completedTurnOrder: [],
      };
      this.sessions.set(key, record);
      if (event.state === "completed" && event.turnId) {
        this.rememberCompletedTurn(record, event.turnId);
      }
      return { result: "applied", session: cloneSnapshot(record) };
    }

    this.rememberRecentEvent(record, event);
    if (compareEventToState(event, record) <= 0) {
      return { result: "stale", session: cloneSnapshot(record) };
    }

    record.state = event.state;
    record.updatedAt = event.occurredAt;
    record.stateOccurredAtMs = Date.parse(event.occurredAt);
    record.stateEventId = event.eventId;

    if (event.state === "completed" && event.turnId) {
      this.rememberCompletedTurn(record, event.turnId);
    }

    return { result: "applied", session: cloneSnapshot(record) };
  }

  get(identity: SessionIdentity): SessionSnapshot | undefined {
    const record = this.sessions.get(createSessionKey(identity));
    return record ? cloneSnapshot(record) : undefined;
  }

  list(): SessionSnapshot[] {
    return [...this.sessions.values()]
      .map(cloneSnapshot)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }

  private rememberEventId(eventId: string): void {
    this.seenEventIds.add(eventId);
    this.seenEventOrder.push(eventId);
    while (this.seenEventOrder.length > this.maxSeenEventIds) {
      const removed = this.seenEventOrder.shift();
      if (removed) {
        this.seenEventIds.delete(removed);
      }
    }
  }

  private rememberRecentEvent(record: SessionRecord, event: AgentEvent): void {
    record.recentEvents.push(structuredClone(event));
    record.recentEvents.sort(compareEvents);
    if (record.recentEvents.length > this.maxRecentEvents) {
      record.recentEvents.splice(0, record.recentEvents.length - this.maxRecentEvents);
    }
  }

  private rememberCompletedTurn(record: SessionRecord, turnId: string): void {
    record.completedTurns.add(turnId);
    record.completedTurnOrder.push(turnId);
    while (record.completedTurnOrder.length > this.maxCompletedTurnsPerSession) {
      const removed = record.completedTurnOrder.shift();
      if (removed) {
        record.completedTurns.delete(removed);
      }
    }
  }
}
