import assert from "node:assert/strict";
import test from "node:test";
import { CodexAdapter, formatCodexPermissionOutcome } from "./index.js";

function adapter() {
  let id = 0;
  return new CodexAdapter({
    now: () => new Date("2026-08-13T12:00:00.000Z"),
    generateId: () => `id-${++id}`,
  });
}

test("maps Codex lifecycle events and keeps one turn identity", () => {
  const instance = adapter();
  const prompt = instance.adapt({
    hook_event_name: "UserPromptSubmit",
    session_id: "session-1",
  });
  const stop = instance.adapt({
    hook_event_name: "Stop",
    session_id: "session-1",
  });

  assert.equal(prompt.kind, "event");
  assert.equal(stop.kind, "event");
  if (prompt.kind === "event" && stop.kind === "event") {
    assert.equal(prompt.event.state, "thinking");
    assert.equal(stop.event.state, "completed");
    assert.equal(stop.event.turnId, prompt.event.turnId);
  }
});

test("Codex permission adaptation retains only bounded metadata", () => {
  const result = adapter().adapt({
    hook_event_name: "PermissionRequest",
    session_id: "session-1",
    tool_name: "Bash",
    tool_input: {
      command: "echo secret",
      description: "Run a command",
    },
  });

  assert.equal(result.kind, "permission");
  if (result.kind === "permission") {
    assert.deepEqual(result.request.tool.name, "Bash");
    assert.equal(result.request.tool.summary, "Run a command");
    assert.equal("command" in result.request.tool, false);
    assert.equal(result.event.state, "waiting_permission");
  }
});

test("Codex permission output uses official decision envelope", () => {
  assert.equal(formatCodexPermissionOutcome({
    requestId: "request-1",
    decision: "no_decision",
    reason: "timeout",
    decidedAt: "2026-08-13T12:00:00.000Z",
  }), "{}");

  assert.deepEqual(JSON.parse(formatCodexPermissionOutcome({
    requestId: "request-1",
    decision: "allow",
    decidedAt: "2026-08-13T12:00:00.000Z",
  })), {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow" },
    },
  });
});
