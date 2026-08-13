import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const PROTOCOL_VERSION = 1;
const MAX_HOOK_BYTES = 256 * 1024;
const MAX_RUNTIME_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024;
const DEFAULT_LIFECYCLE_TIMEOUT_MS = 1_000;
const DEFAULT_PERMISSION_TIMEOUT_MS = 9 * 60 * 1_000;
const TOKEN_PATTERN = /^[a-zA-Z0-9_-]{20,256}$/;

export type HookAgent = "codex" | "copilot";

interface RuntimeConfig {
  protocolVersion: typeof PROTOCOL_VERSION;
  host: "127.0.0.1";
  port: number;
  pid: number;
  startedAt: string;
  authToken: string;
}

export interface RunHookOptions {
  agent: HookAgent;
  input: string;
  eventName?: string;
  runtimeFilePath?: string;
  fetchImpl?: typeof fetch;
  lifecycleTimeoutMs?: number;
  permissionTimeoutMs?: number;
}

export interface HookRunResult {
  stdout: string;
  delivered: boolean;
  permission: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function fallbackOutput(agent: HookAgent): string {
  return agent === "codex" ? "{}" : "";
}

function parseInput(input: string): Record<string, unknown> {
  if (Buffer.byteLength(input, "utf8") > MAX_HOOK_BYTES) {
    throw new Error(`hook input exceeds ${MAX_HOOK_BYTES} bytes`);
  }
  const parsed: unknown = JSON.parse(input);
  if (!isRecord(parsed)) {
    throw new Error("hook input must be a JSON object");
  }
  return parsed;
}

function permissionEvent(
  agent: HookAgent,
  eventName: string | undefined,
  input: Record<string, unknown>,
): boolean {
  if (agent === "codex") {
    return input.hook_event_name === "PermissionRequest";
  }
  return eventName === "permissionRequest";
}

function endpointFor(
  agent: HookAgent,
  eventName: string | undefined,
): string {
  if (agent === "codex") {
    return "/v1/hooks/codex";
  }
  if (!eventName || !/^[a-zA-Z]+$/.test(eventName)) {
    throw new Error("Copilot hook event name is invalid");
  }
  return `/v1/hooks/copilot/${eventName}`;
}

function validateRuntimeConfig(value: unknown): RuntimeConfig {
  if (!isRecord(value)) {
    throw new Error("runtime config must be an object");
  }
  if (
    value.protocolVersion !== PROTOCOL_VERSION
    || value.host !== "127.0.0.1"
    || typeof value.port !== "number"
    || !Number.isInteger(value.port)
    || value.port < 1
    || value.port > 65_535
    || typeof value.pid !== "number"
    || !Number.isInteger(value.pid)
    || value.pid < 1
    || typeof value.startedAt !== "string"
    || Number.isNaN(Date.parse(value.startedAt))
    || typeof value.authToken !== "string"
    || !TOKEN_PATTERN.test(value.authToken)
  ) {
    throw new Error("runtime config is invalid");
  }
  return value as unknown as RuntimeConfig;
}

async function loadRuntimeConfig(path: string): Promise<RuntimeConfig> {
  const handle = await open(path, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_RUNTIME_BYTES) {
      throw new Error("runtime config file is invalid");
    }
    if (process.platform !== "win32") {
      if ((stat.mode & 0o077) !== 0) {
        throw new Error("runtime config permissions are too broad");
      }
      if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
        throw new Error("runtime config has an unexpected owner");
      }
    }
    const text = await handle.readFile("utf8");
    return validateRuntimeConfig(JSON.parse(text));
  } finally {
    await handle.close();
  }
}

async function readResponseText(response: Response): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null
    && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_RESPONSE_BYTES)
  ) {
    throw new Error("receiver response is too large");
  }
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      size += result.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        throw new Error("receiver response is too large");
      }
      chunks.push(result.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function canonicalCodexOutput(text: string): string {
  const value: unknown = JSON.parse(text);
  if (isRecord(value) && Object.keys(value).length === 0) {
    return "{}";
  }
  if (!isRecord(value) || !hasOnlyKeys(value, ["hookSpecificOutput"])) {
    throw new Error("invalid Codex permission response");
  }
  const output = value.hookSpecificOutput;
  if (!isRecord(output) || !hasOnlyKeys(output, ["hookEventName", "decision"])) {
    throw new Error("invalid Codex permission response");
  }
  const decision = output.decision;
  if (
    output.hookEventName !== "PermissionRequest"
    || !isRecord(decision)
    || !hasOnlyKeys(decision, ["behavior", "message"])
    || (decision.behavior !== "allow" && decision.behavior !== "deny")
    || (decision.message !== undefined && typeof decision.message !== "string")
    || (decision.behavior === "allow" && decision.message !== undefined)
  ) {
    throw new Error("invalid Codex permission response");
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: decision.behavior,
        ...(decision.behavior === "deny" && decision.message
          ? { message: decision.message.slice(0, 256) }
          : {}),
      },
    },
  });
}

function canonicalCopilotOutput(text: string): string {
  const value: unknown = JSON.parse(text);
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, ["behavior", "message"])
    || (value.behavior !== "allow" && value.behavior !== "deny")
    || (value.message !== undefined && typeof value.message !== "string")
    || (value.behavior === "allow" && value.message !== undefined)
  ) {
    throw new Error("invalid Copilot permission response");
  }
  return JSON.stringify({
    behavior: value.behavior,
    ...(value.behavior === "deny" && value.message
      ? { message: value.message.slice(0, 256) }
      : {}),
  });
}

export async function readHookInput(
  input: AsyncIterable<Uint8Array | string>,
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_HOOK_BYTES) {
      throw new Error(`hook input exceeds ${MAX_HOOK_BYTES} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runHook(options: RunHookOptions): Promise<HookRunResult> {
  const input = parseInput(options.input);
  const permission = permissionEvent(options.agent, options.eventName, input);
  const runtimePath = options.runtimeFilePath
    ?? process.env.VIBEMATE_RUNTIME_PATH
    ?? join(homedir(), ".vibemate", "runtime.json");
  const runtime = await loadRuntimeConfig(runtimePath);
  const timeoutMs = permission
    ? options.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS
    : options.lifecycleTimeoutMs ?? DEFAULT_LIFECYCLE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("hook timeout must be a positive integer");
  }

  const response = await (options.fetchImpl ?? fetch)(
    `http://${runtime.host}:${runtime.port}${endpointFor(options.agent, options.eventName)}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vibemate-token": runtime.authToken,
      },
      body: options.input,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    },
  );

  if (!permission) {
    const delivered = response.status >= 200 && response.status < 300;
    await response.body?.cancel();
    if (!delivered) {
      throw new Error(`receiver rejected lifecycle event with HTTP ${response.status}`);
    }
    return {
      stdout: fallbackOutput(options.agent),
      delivered: true,
      permission: false,
    };
  }

  if (options.agent === "copilot" && response.status === 204) {
    await response.body?.cancel();
    return { stdout: "", delivered: true, permission: true };
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`receiver rejected permission event with HTTP ${response.status}`);
  }
  const text = await readResponseText(response);
  return {
    stdout: options.agent === "codex"
      ? canonicalCodexOutput(text)
      : canonicalCopilotOutput(text),
    delivered: true,
    permission: true,
  };
}

export function nativeFallback(agent: HookAgent): string {
  return fallbackOutput(agent);
}
