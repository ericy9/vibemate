export const PROTOCOL_VERSION = 1 as const;

export const MAX_EVENT_BYTES = 16 * 1024;
export const MAX_PERMISSION_REQUEST_BYTES = 32 * 1024;
export const MAX_EVENT_NAME_LENGTH = 100;
export const MAX_SESSION_ID_LENGTH = 256;
export const MAX_SOURCE_PROFILE_LENGTH = 64;
export const MAX_CWD_LENGTH = 4096;
export const MAX_TOOL_NAME_LENGTH = 128;
export const MAX_TOOL_SUMMARY_LENGTH = 512;

export const AGENT_IDS = ["codex", "copilot"] as const;

export const UNIFIED_STATES = [
  "idle",
  "thinking",
  "working",
  "waiting_permission",
  "completed",
  "failed",
  "ended",
] as const;
