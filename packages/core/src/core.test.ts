import assert from "node:assert/strict";
import test from "node:test";
import {
  parseAgentEvent,
  parsePermissionDecision,
  parsePermissionRequest,
} from "@vibemate/protocol";
import { PermissionBroker, SessionStore } from "./index.js";

function event(overrides: Record<string, unknown> = {}) {
  return parseAgentEvent({
    protocolVersion: 1,
    eventId: "event-1",
    sourceProfile: "local",
    agent: "codex",
    sessionId: "session-1",
    state: "working",
    event: "PreToolUse",
    occurredAt: "2026-08-13T12:00:00.000Z",
    ...overrides,
  });
}

test("session store isolates agents with the same raw session id", () => {
  const store = new SessionStore();
  store.apply(event());
  store.apply(event({
    eventId: "event-2",
    agent: "copilot",
    state: "thinking",
    event: "userPromptSubmitted",
  }));

  assert.equal(store.list().length, 2);
});

test("event ids are deduplicated inside their session namespace", () => {
  const store = new SessionStore();
  assert.equal(store.apply(event()).result, "applied");
  assert.equal(store.apply(event({
    agent: "copilot",
    state: "thinking",
    event: "userPromptSubmitted",
  })).result, "applied");

  const snapshots = store.list();
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots.every((snapshot) => snapshot.recentEvents.length === 1), true);
});

test("session store ignores duplicate and stale events deterministically", () => {
  const store = new SessionStore();
  assert.equal(store.apply(event()).result, "applied");
  assert.equal(store.apply(event()).result, "duplicate_event");
  assert.equal(store.apply(event({
    eventId: "event-0",
    state: "thinking",
    event: "UserPromptSubmit",
    occurredAt: "2026-08-13T11:59:00.000Z",
  })).result, "stale");

  const snapshot = store.list()[0];
  assert.equal(snapshot?.state, "working");
});

test("session store orders timestamps by instant rather than offset text", () => {
  const store = new SessionStore();
  store.apply(event({
    occurredAt: "2026-08-14T01:00:00.000Z",
  }));
  assert.equal(store.apply(event({
    eventId: "event-2",
    state: "completed",
    event: "Stop",
    turnId: "turn-1",
    occurredAt: "2026-08-13T23:00:00.000-05:00",
  })).result, "applied");
  assert.equal(store.list()[0]?.state, "completed");
});

test("session store emits at most one completion per turn", () => {
  const store = new SessionStore();
  assert.equal(store.apply(event({
    eventId: "complete-1",
    state: "completed",
    event: "Stop",
    turnId: "turn-1",
  })).result, "applied");
  assert.equal(store.apply(event({
    eventId: "complete-2",
    state: "completed",
    event: "agentStop",
    turnId: "turn-1",
    occurredAt: "2026-08-13T12:00:01.000Z",
  })).result, "duplicate_completion");
});

test("session store notifies subscribers when its visible snapshot changes", () => {
  const store = new SessionStore();
  let notifications = 0;
  const unsubscribe = store.subscribe(() => {
    notifications += 1;
  });

  store.apply(event());
  store.apply(event());
  store.apply(event({
    eventId: "event-0",
    occurredAt: "2026-08-13T11:59:00.000Z",
  }));
  unsubscribe();
  store.apply(event({
    eventId: "event-2",
    occurredAt: "2026-08-13T12:01:00.000Z",
  }));

  assert.equal(notifications, 2);
});

test("permission broker accepts only a matching first decision", async () => {
  const broker = new PermissionBroker({
    now: () => new Date("2026-08-13T12:00:05.000Z"),
  });

  const request = parsePermissionRequest({
    protocolVersion: 1,
    requestId: "request-1",
    sourceProfile: "local",
    agent: "codex",
    sessionId: "session-1",
    occurredAt: "2026-08-13T12:00:00.000Z",
    expiresAt: "2026-08-13T12:01:00.000Z",
    tool: { name: "shell", summary: "Run tests" },
  });
  const outcomePromise = broker.waitForDecision(request);

  assert.equal(broker.submitDecision(parsePermissionDecision({
    protocolVersion: 1,
    requestId: "request-1",
    sourceProfile: "local",
    agent: "copilot",
    sessionId: "session-1",
    decision: "allow",
    decidedAt: "2026-08-13T12:00:06.000Z",
  })), "identity_mismatch");

  assert.equal(broker.submitDecision(parsePermissionDecision({
    protocolVersion: 1,
    requestId: "request-1",
    sourceProfile: "local",
    agent: "codex",
    sessionId: "session-1",
    decision: "deny",
    decidedAt: "2026-08-13T12:00:07.000Z",
  })), "accepted");

  assert.deepEqual(await outcomePromise, {
    requestId: "request-1",
    decision: "deny",
    decidedAt: "2026-08-13T12:00:07.000Z",
  });
  assert.equal(broker.submitDecision(parsePermissionDecision({
    protocolVersion: 1,
    requestId: "request-1",
    sourceProfile: "local",
    agent: "codex",
    sessionId: "session-1",
    decision: "allow",
    decidedAt: "2026-08-13T12:00:08.000Z",
  })), "already_finalized");
});

test("permission broker notifies subscribers when pending requests change", async () => {
  const broker = new PermissionBroker({
    now: () => new Date("2026-08-13T12:00:05.000Z"),
  });
  const pendingCounts: number[] = [];
  const unsubscribe = broker.subscribe(() => {
    pendingCounts.push(broker.listPending().length);
  });
  const request = parsePermissionRequest({
    protocolVersion: 1,
    requestId: "request-notify",
    sourceProfile: "local",
    agent: "codex",
    sessionId: "session-1",
    occurredAt: "2026-08-13T12:00:00.000Z",
    expiresAt: "2026-08-13T12:01:00.000Z",
    tool: { name: "shell" },
  });

  const outcome = broker.waitForDecision(request);
  broker.submitDecision(parsePermissionDecision({
    protocolVersion: 1,
    requestId: request.requestId,
    sourceProfile: request.sourceProfile,
    agent: request.agent,
    sessionId: request.sessionId,
    decision: "allow",
    decidedAt: "2026-08-13T12:00:06.000Z",
  }));
  await outcome;
  unsubscribe();

  assert.deepEqual(pendingCounts, [1, 0]);
});

test("permission broker isolates equal request ids across sessions", async () => {
  const broker = new PermissionBroker({
    now: () => new Date("2026-08-13T12:00:05.000Z"),
  });
  const base = {
    protocolVersion: 1 as const,
    requestId: "shared-request",
    sourceProfile: "local",
    agent: "codex" as const,
    occurredAt: "2026-08-13T12:00:00.000Z",
    expiresAt: "2026-08-13T12:01:00.000Z",
    tool: { name: "shell" },
  };
  const first = parsePermissionRequest({ ...base, sessionId: "session-1" });
  const second = parsePermissionRequest({ ...base, sessionId: "session-2" });
  const firstOutcome = broker.waitForDecision(first);
  const secondOutcome = broker.waitForDecision(second);

  for (const request of [first, second]) {
    assert.equal(broker.submitDecision(parsePermissionDecision({
      protocolVersion: 1,
      requestId: request.requestId,
      sourceProfile: request.sourceProfile,
      agent: request.agent,
      sessionId: request.sessionId,
      decision: "allow",
      decidedAt: "2026-08-13T12:00:06.000Z",
    })), "accepted");
  }

  assert.equal((await firstOutcome).decision, "allow");
  assert.equal((await secondOutcome).decision, "allow");
});

test("permission broker resolves no decision on shutdown", async () => {
  const broker = new PermissionBroker({
    now: () => new Date("2026-08-13T12:00:05.000Z"),
  });
  const request = parsePermissionRequest({
    protocolVersion: 1,
    requestId: "request-2",
    sourceProfile: "local",
    agent: "copilot",
    sessionId: "session-2",
    occurredAt: "2026-08-13T12:00:00.000Z",
    expiresAt: "2026-08-13T12:01:00.000Z",
    tool: { name: "shell" },
  });
  const outcomePromise = broker.waitForDecision(request);

  assert.equal(broker.shutdown(), 1);
  assert.deepEqual(await outcomePromise, {
    requestId: "request-2",
    decision: "no_decision",
    reason: "shutdown",
    decidedAt: "2026-08-13T12:00:05.000Z",
  });

  const afterShutdown = await broker.waitForDecision(parsePermissionRequest({
    protocolVersion: 1,
    requestId: "request-3",
    sourceProfile: "local",
    agent: "copilot",
    sessionId: "session-2",
    occurredAt: "2026-08-13T12:00:00.000Z",
    expiresAt: "2026-08-13T12:01:00.000Z",
    tool: { name: "shell" },
  }));
  assert.equal(afterShutdown.decision, "no_decision");
  assert.equal("reason" in afterShutdown && afterShutdown.reason, "shutdown");
});

test("permission broker expires requests without an external sweep", async () => {
  const broker = new PermissionBroker();
  const now = Date.now();
  const outcome = await broker.waitForDecision(parsePermissionRequest({
    protocolVersion: 1,
    requestId: "request-auto-expire",
    sourceProfile: "local",
    agent: "codex",
    sessionId: "session-1",
    occurredAt: new Date(now - 10).toISOString(),
    expiresAt: new Date(now + 30).toISOString(),
    tool: { name: "shell" },
  }));

  assert.equal(outcome.decision, "no_decision");
  assert.equal("reason" in outcome && outcome.reason, "timeout");
});

test("permission broker fails safely when pending capacity is exhausted", async () => {
  const broker = new PermissionBroker({
    now: () => new Date("2026-08-13T12:00:05.000Z"),
    maxPendingRequests: 1,
  });
  const first = parsePermissionRequest({
    protocolVersion: 1,
    requestId: "request-capacity-1",
    sourceProfile: "local",
    agent: "codex",
    sessionId: "session-1",
    occurredAt: "2026-08-13T12:00:00.000Z",
    expiresAt: "2026-08-13T12:01:00.000Z",
    tool: { name: "shell" },
  });
  const second = parsePermissionRequest({
    ...first,
    requestId: "request-capacity-2",
  });

  void broker.waitForDecision(first);
  const outcome = await broker.waitForDecision(second);
  assert.equal(outcome.decision, "no_decision");
  assert.equal("reason" in outcome && outcome.reason, "broker_capacity");
  broker.shutdown();
});
