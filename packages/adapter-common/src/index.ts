import { createHash, randomUUID } from "node:crypto";
import {
  MAX_CWD_LENGTH,
  MAX_TOOL_NAME_LENGTH,
  MAX_TOOL_SUMMARY_LENGTH,
  sanitizeText,
  type AgentId,
} from "@vibemate/protocol";

const BOUNDED_ID = /^[a-zA-Z0-9._:-]{1,128}$/;

export class AdapterInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterInputError";
  }
}

export interface AdapterRuntimeOptions {
  sourceProfile?: string;
  now?: () => Date;
  generateId?: () => string;
  permissionTimeoutMs?: number;
}

export interface ToolMetadataInput {
  name: string;
  input?: unknown;
}

export type AdapterPermissionOutcome =
  | {
      requestId: string;
      decision: "allow" | "deny";
      decidedAt: string;
    }
  | {
      requestId: string;
      decision: "no_decision";
      reason: string;
      decidedAt: string;
    };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) {
    throw new AdapterInputError(`${label} must be an object`);
  }
  return record;
}

export function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return asRecord(value);
}

export function decodeJsonValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function readOptionalString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function requireString(label: string, ...values: unknown[]): string {
  const value = readOptionalString(...values);
  if (!value) {
    throw new AdapterInputError(`${label} is required`);
  }
  return value;
}

export function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  const record = optionalRecord(value);
  if (record) {
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
}

export function fingerprintInput(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(canonicalize(value));
  } catch {
    return undefined;
  }
  return createHash("sha256").update(serialized).digest("hex");
}

export function buildToolMetadata(input: ToolMetadataInput) {
  const name = sanitizeText(input.name, { maxLength: MAX_TOOL_NAME_LENGTH });
  if (!name || /^unknown$/i.test(name)) {
    throw new AdapterInputError("tool name is invalid");
  }

  const rawInput = optionalRecord(input.input);
  const rawDescription = rawInput?.description;
  const summary = typeof rawDescription === "string"
    ? sanitizeText(rawDescription, { maxLength: MAX_TOOL_SUMMARY_LENGTH })
    : `Request to use ${name}`;
  const inputFingerprint = fingerprintInput(input.input);

  return {
    name,
    ...(summary ? { summary } : {}),
    ...(inputFingerprint ? { inputFingerprint } : {}),
  };
}

export class AdapterRuntime {
  readonly sourceProfile: string;
  readonly permissionTimeoutMs: number;
  private readonly nowProvider: () => Date;
  private readonly idProvider: () => string;
  private readonly activeTurns = new Map<string, string>();

  constructor(options: AdapterRuntimeOptions = {}) {
    this.sourceProfile = options.sourceProfile ?? "local";
    this.permissionTimeoutMs = options.permissionTimeoutMs ?? 9 * 60 * 1_000;
    this.nowProvider = options.now ?? (() => new Date());
    this.idProvider = options.generateId ?? randomUUID;
  }

  now(): Date {
    return this.nowProvider();
  }

  occurredAt(value: unknown): string {
    if (typeof value === "number" && Number.isFinite(value)) {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) {
        return date.toISOString();
      }
    }
    if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
      return new Date(value).toISOString();
    }
    return this.now().toISOString();
  }

  eventId(...candidates: unknown[]): string {
    return this.boundedId(candidates) ?? this.idProvider();
  }

  requestId(...candidates: unknown[]): string {
    return this.boundedId(candidates) ?? this.idProvider();
  }

  startTurn(agent: AgentId, sessionId: string, preferred?: unknown): string {
    const turnId = this.boundedId([preferred]) ?? `turn-${this.idProvider()}`;
    this.activeTurns.set(this.turnKey(agent, sessionId), turnId);
    return turnId;
  }

  currentTurn(agent: AgentId, sessionId: string): string | undefined {
    return this.activeTurns.get(this.turnKey(agent, sessionId));
  }

  ensureTurn(agent: AgentId, sessionId: string, preferred?: unknown): string {
    const explicit = this.boundedId([preferred]);
    if (explicit) {
      this.activeTurns.set(this.turnKey(agent, sessionId), explicit);
      return explicit;
    }
    return this.currentTurn(agent, sessionId) ?? this.startTurn(agent, sessionId);
  }

  cwd(value: unknown): string | undefined {
    return typeof value === "string" && value.trim()
      ? sanitizeText(value, { maxLength: MAX_CWD_LENGTH, collapseWhitespace: false })
      : undefined;
  }

  expiresAt(): string {
    return new Date(this.now().getTime() + this.permissionTimeoutMs).toISOString();
  }

  private boundedId(values: unknown[]): string | undefined {
    for (const value of values) {
      if (typeof value === "string" && BOUNDED_ID.test(value.trim())) {
        return value.trim();
      }
    }
    return undefined;
  }

  private turnKey(agent: AgentId, sessionId: string): string {
    return `${agent}\u0000${sessionId}`;
  }
}
