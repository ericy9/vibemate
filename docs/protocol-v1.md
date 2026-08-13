# VibeMate Protocol v1

## Purpose

Protocol v1 is the stable boundary between Agent adapters, the core service,
observers, and future desktop or remote clients. Agent-specific field names do
not enter the shared session store.

## Event identity

Every event identifies its origin with:

```text
sourceProfile + agent + sessionId
```

The internal key is a versioned, encoded representation of all three fields.
Raw session IDs from different Agents or machines therefore cannot collide.

## Lifecycle event

```json
{
  "protocolVersion": 1,
  "eventId": "event-01",
  "sourceProfile": "local",
  "agent": "codex",
  "sessionId": "agent-session-id",
  "state": "working",
  "event": "PreToolUse",
  "occurredAt": "2026-08-13T12:00:00.000Z",
  "turnId": "turn-01",
  "cwd": "/path/to/project",
  "tool": {
    "name": "shell",
    "summary": "Run project tests",
    "inputFingerprint": "0123456789abcdef0123456789abcdef01234567"
  },
  "process": {
    "sourcePid": 1234
  }
}
```

Unknown fields are rejected. In particular, the shared event schema has no
field for prompts, file contents, command output, tokens, or unrestricted tool
input.

`completed` events require a `turnId`, allowing the core to expose at most one
completion per turn even if multiple Agent signals describe the same result.

## Permission request

```json
{
  "protocolVersion": 1,
  "requestId": "request-01",
  "sourceProfile": "local",
  "agent": "copilot",
  "sessionId": "agent-session-id",
  "occurredAt": "2026-08-13T12:00:00.000Z",
  "expiresAt": "2026-08-13T12:01:00.000Z",
  "tool": {
    "name": "shell",
    "summary": "Run project tests"
  }
}
```

Permission decisions repeat the complete request identity. A decision is
accepted only if `requestId`, `sourceProfile`, `agent`, and `sessionId` all
match a pending request.

## Limits

| Item | Limit |
| --- | ---: |
| Lifecycle event | 16 KiB |
| Permission request | 32 KiB |
| Tool summary | 512 characters |
| Session ID | 256 characters |
| Event name | 100 characters |

Adapters must sanitize and bound metadata before creating protocol messages.
Core validation remains strict even when an adapter is trusted.

## Failure behavior

- Duplicate event IDs are ignored.
- Older events are retained only in the bounded diagnostic history and do not
  replace newer session state.
- A permission request accepts only the first valid final decision.
- Timeout, shutdown, an aborted waiting connection, or broker capacity
  exhaustion resolves to `no_decision`.
- `no_decision` tells the adapter to invoke the Agent's native permission
  fallback. It is never converted into Allow or Deny.
