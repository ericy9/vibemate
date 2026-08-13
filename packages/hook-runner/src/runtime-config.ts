import { open } from "node:fs/promises";

export const RUNTIME_PROTOCOL_VERSION = 1 as const;
export const LOOPBACK_HOST = "127.0.0.1" as const;
const MAX_RUNTIME_BYTES = 16 * 1024;
const TOKEN_PATTERN = /^[a-zA-Z0-9_-]{20,256}$/;

export interface RuntimeConfig {
  protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
  host: typeof LOOPBACK_HOST;
  port: number;
  pid: number;
  startedAt: string;
  authToken: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseRuntimeConfig(value: unknown): RuntimeConfig {
  if (!isRecord(value)) {
    throw new Error("runtime config must be an object");
  }
  if (
    value.protocolVersion !== RUNTIME_PROTOCOL_VERSION
    || value.host !== LOOPBACK_HOST
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

export async function loadRuntimeConfig(path: string): Promise<RuntimeConfig> {
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
    return parseRuntimeConfig(JSON.parse(await handle.readFile("utf8")));
  } finally {
    await handle.close();
  }
}
