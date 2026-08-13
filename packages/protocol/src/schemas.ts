import { z } from "zod";
import {
  AGENT_IDS,
  MAX_CWD_LENGTH,
  MAX_EVENT_BYTES,
  MAX_EVENT_NAME_LENGTH,
  MAX_PERMISSION_REQUEST_BYTES,
  MAX_SESSION_ID_LENGTH,
  MAX_SOURCE_PROFILE_LENGTH,
  MAX_TOOL_NAME_LENGTH,
  MAX_TOOL_SUMMARY_LENGTH,
  PROTOCOL_VERSION,
  UNIFIED_STATES,
} from "./constants.js";
import { sanitizeText } from "./sanitize.js";

const sourceProfileSchema = z.string()
  .min(1)
  .max(MAX_SOURCE_PROFILE_LENGTH)
  .regex(/^[a-zA-Z0-9_-]+$/);

const sessionIdSchema = z.string()
  .trim()
  .min(1)
  .max(MAX_SESSION_ID_LENGTH)
  .regex(/^[^\u0000-\u001f\u007f-\u009f]+$/);

const boundedIdSchema = z.string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9._:-]+$/);

const occurredAtSchema = z.string().datetime({ offset: true });

function sanitizedString(maxLength: number, collapseWhitespace = true) {
  return z.string()
    .transform((value) => sanitizeText(value, { maxLength, collapseWhitespace }))
    .pipe(z.string().min(1).max(maxLength));
}

const identityShape = {
  sourceProfile: sourceProfileSchema,
  agent: z.enum(AGENT_IDS),
  sessionId: sessionIdSchema,
};

export const toolMetadataSchema = z.object({
  name: sanitizedString(MAX_TOOL_NAME_LENGTH),
  summary: sanitizedString(MAX_TOOL_SUMMARY_LENGTH).optional(),
  inputFingerprint: z.string().regex(/^[a-f0-9]{40,64}$/i).optional(),
}).strict();

export const processMetadataSchema = z.object({
  sourcePid: z.number().int().positive(),
}).strict();

export const agentEventSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  eventId: boundedIdSchema,
  ...identityShape,
  state: z.enum(UNIFIED_STATES),
  event: sanitizedString(MAX_EVENT_NAME_LENGTH),
  occurredAt: occurredAtSchema,
  cwd: sanitizedString(MAX_CWD_LENGTH, false).optional(),
  turnId: boundedIdSchema.optional(),
  tool: toolMetadataSchema.optional(),
  process: processMetadataSchema.optional(),
}).strict().superRefine((event, context) => {
  if (event.state === "completed" && !event.turnId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["turnId"],
      message: "completed events require turnId for deterministic deduplication",
    });
  }
});

export const permissionRequestSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: boundedIdSchema,
  ...identityShape,
  occurredAt: occurredAtSchema,
  expiresAt: occurredAtSchema,
  tool: toolMetadataSchema,
}).strict().superRefine((request, context) => {
  if (Date.parse(request.expiresAt) <= Date.parse(request.occurredAt)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expiresAt"],
      message: "expiresAt must be later than occurredAt",
    });
  }
});

export const permissionDecisionSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: boundedIdSchema,
  ...identityShape,
  decision: z.enum(["allow", "deny"]),
  decidedAt: occurredAtSchema,
}).strict();

export type AgentEvent = z.infer<typeof agentEventSchema>;
export type UnifiedState = AgentEvent["state"];
export type PermissionRequest = z.infer<typeof permissionRequestSchema>;
export type PermissionDecision = z.infer<typeof permissionDecisionSchema>;

function parseBounded<T>(schema: z.ZodType<T>, value: unknown, maxBytes: number): T {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError("payload must be JSON serializable");
  }

  if (typeof serialized !== "string") {
    throw new TypeError("payload must be a JSON value");
  }

  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new RangeError(`payload exceeds ${maxBytes} bytes`);
  }

  return schema.parse(value);
}

export function parseAgentEvent(value: unknown): AgentEvent {
  return parseBounded(agentEventSchema, value, MAX_EVENT_BYTES);
}

export function parsePermissionRequest(value: unknown): PermissionRequest {
  return parseBounded(permissionRequestSchema, value, MAX_PERMISSION_REQUEST_BYTES);
}

export function parsePermissionDecision(value: unknown): PermissionDecision {
  return parseBounded(permissionDecisionSchema, value, MAX_EVENT_BYTES);
}
