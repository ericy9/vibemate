import {
  AGENT_IDS,
  MAX_SESSION_ID_LENGTH,
  MAX_SOURCE_PROFILE_LENGTH,
} from "./constants.js";

export type AgentId = (typeof AGENT_IDS)[number];

export interface SessionIdentity {
  sourceProfile: string;
  agent: AgentId;
  sessionId: string;
}

const SESSION_KEY_PREFIX = "v1";

function encodePart(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodePart(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

export function createSessionKey(identity: SessionIdentity): string {
  if (!identity.sourceProfile || identity.sourceProfile.length > MAX_SOURCE_PROFILE_LENGTH) {
    throw new TypeError("sourceProfile is invalid");
  }
  if (!AGENT_IDS.includes(identity.agent)) {
    throw new TypeError("agent is invalid");
  }
  if (!identity.sessionId || identity.sessionId.length > MAX_SESSION_ID_LENGTH) {
    throw new TypeError("sessionId is invalid");
  }

  return [
    SESSION_KEY_PREFIX,
    encodePart(identity.sourceProfile),
    identity.agent,
    encodePart(identity.sessionId),
  ].join(".");
}

export function parseSessionKey(key: string): SessionIdentity {
  const parts = key.split(".");
  if (parts.length !== 4 || parts[0] !== SESSION_KEY_PREFIX) {
    throw new TypeError("session key is invalid");
  }

  const agent = parts[2];
  if (!agent || !AGENT_IDS.includes(agent as AgentId)) {
    throw new TypeError("session key agent is invalid");
  }

  const sourceProfile = decodePart(parts[1] ?? "");
  const sessionId = decodePart(parts[3] ?? "");
  const identity = { sourceProfile, agent: agent as AgentId, sessionId };

  if (createSessionKey(identity) !== key) {
    throw new TypeError("session key is not canonical");
  }

  return identity;
}
