import {
  AdapterInputError,
  AdapterRuntime,
  buildToolMetadata,
  optionalRecord,
  readOptionalString,
  readPositiveInteger,
  requireRecord,
  requireString,
  type AdapterPermissionOutcome,
  type AdapterRuntimeOptions,
} from "@vibemate/adapter-common";
import {
  parseAgentEvent,
  parsePermissionRequest,
  PROTOCOL_VERSION,
  type AgentEvent,
  type PermissionRequest,
  type UnifiedState,
} from "@vibemate/protocol";

const CODEX_STATES: Record<string, UnifiedState> = {
  SessionStart: "idle",
  UserPromptSubmit: "thinking",
  PreToolUse: "working",
  PostToolUse: "working",
  Stop: "completed",
};

export type CodexAdapterResult =
  | { kind: "event"; event: AgentEvent }
  | { kind: "permission"; event: AgentEvent; request: PermissionRequest }
  | { kind: "ignored"; reason: string };

export class CodexAdapter {
  private readonly runtime: AdapterRuntime;

  constructor(options: AdapterRuntimeOptions = {}) {
    this.runtime = new AdapterRuntime(options);
  }

  adapt(value: unknown): CodexAdapterResult {
    const payload = requireRecord(value, "Codex hook payload");
    const eventName = requireString("hook_event_name", payload.hook_event_name);

    if (eventName === "PermissionRequest") {
      return this.adaptPermission(payload);
    }

    const state = CODEX_STATES[eventName];
    if (!state) {
      return { kind: "ignored", reason: `unsupported Codex event: ${eventName}` };
    }
    if (eventName === "Stop" && payload.stop_hook_active === true) {
      return { kind: "ignored", reason: "recursive Stop hook" };
    }

    const sessionId = requireString("session_id", payload.session_id);
    const eventId = this.runtime.eventId(payload.event_id, payload.eventId);
    const explicitTurnId = readOptionalString(payload.turn_id, payload.turnId);
    let turnId: string | undefined;
    if (eventName === "UserPromptSubmit") {
      turnId = this.runtime.startTurn("codex", sessionId, explicitTurnId);
    } else if (eventName === "Stop") {
      turnId = this.runtime.ensureTurn("codex", sessionId, explicitTurnId);
    } else {
      turnId = explicitTurnId ?? this.runtime.currentTurn("codex", sessionId);
    }

    const toolName = readOptionalString(payload.tool_name, payload.toolName);
    const toolInput = payload.tool_input ?? payload.toolInput;
    const cwd = this.runtime.cwd(payload.cwd);
    const sourcePid = readPositiveInteger(payload.source_pid);

    return {
      kind: "event",
      event: parseAgentEvent({
        protocolVersion: PROTOCOL_VERSION,
        eventId,
        sourceProfile: this.runtime.sourceProfile,
        agent: "codex",
        sessionId,
        state,
        event: eventName,
        occurredAt: this.runtime.occurredAt(payload.occurred_at ?? payload.timestamp),
        ...(turnId ? { turnId } : {}),
        ...(cwd ? { cwd } : {}),
        ...(toolName ? { tool: buildToolMetadata({ name: toolName, input: toolInput }) } : {}),
        ...(sourcePid ? { process: { sourcePid } } : {}),
      }),
    };
  }

  private adaptPermission(payload: Record<string, unknown>): CodexAdapterResult {
    const sessionId = requireString("session_id", payload.session_id);
    const toolName = requireString("tool_name", payload.tool_name, payload.toolName);
    const toolInput = optionalRecord(payload.tool_input ?? payload.toolInput);
    if (!toolInput) {
      throw new AdapterInputError("tool_input must be an object");
    }

    const requestId = this.runtime.requestId(payload.request_id, payload.requestId);
    const occurredAt = this.runtime.occurredAt(payload.occurred_at ?? payload.timestamp);
    const tool = buildToolMetadata({ name: toolName, input: toolInput });
    const turnId = this.runtime.ensureTurn(
      "codex",
      sessionId,
      readOptionalString(payload.turn_id, payload.turnId),
    );
    const cwd = this.runtime.cwd(payload.cwd);

    return {
      kind: "permission",
      request: parsePermissionRequest({
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        sourceProfile: this.runtime.sourceProfile,
        agent: "codex",
        sessionId,
        occurredAt,
        expiresAt: this.runtime.expiresAt(),
        tool,
      }),
      event: parseAgentEvent({
        protocolVersion: PROTOCOL_VERSION,
        eventId: `permission-${requestId}`,
        sourceProfile: this.runtime.sourceProfile,
        agent: "codex",
        sessionId,
        state: "waiting_permission",
        event: "PermissionRequest",
        occurredAt,
        turnId,
        tool,
        ...(cwd ? { cwd } : {}),
      }),
    };
  }
}

export function formatCodexPermissionOutcome(outcome: AdapterPermissionOutcome): string {
  if (outcome.decision === "no_decision") {
    return "{}";
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: outcome.decision,
        ...(outcome.decision === "deny" ? { message: "Denied in VibeMate" } : {}),
      },
    },
  });
}
