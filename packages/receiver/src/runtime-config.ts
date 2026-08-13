import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { dirname } from "node:path";
import { PROTOCOL_VERSION } from "@vibemate/protocol";

export interface RuntimeConfig {
  protocolVersion: typeof PROTOCOL_VERSION;
  host: "127.0.0.1";
  port: number;
  pid: number;
  startedAt: string;
  authToken: string;
}

export interface RuntimeLock {
  path: string;
  ownerId: string;
  handle: FileHandle;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

export async function acquireRuntimeLock(runtimePath: string): Promise<RuntimeLock> {
  await mkdir(dirname(runtimePath), { recursive: true, mode: 0o700 });
  const path = `${runtimePath}.lock`;

  for (let attempt = 0; attempt < 10; attempt++) {
    const ownerId = randomUUID();
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, ownerId })}\n`, "utf8");
      await handle.sync();
      return { path, ownerId, handle };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
    }

    let existing: unknown;
    try {
      existing = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        continue;
      }
      existing = null;
    }

    const existingPid = existing
      && typeof existing === "object"
      && "pid" in existing
      && typeof existing.pid === "number"
      ? existing.pid
      : null;
    if (existingPid && processIsAlive(existingPid)) {
      throw new Error(`another VibeMate receiver owns ${runtimePath}`);
    }

    const stalePath = `${path}.stale-${process.pid}-${randomUUID()}`;
    try {
      await rename(path, stalePath);
      await rm(stalePath, { force: true });
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw error;
      }
    }
  }

  throw new Error(`could not acquire VibeMate runtime lock: ${runtimePath}`);
}

export async function releaseRuntimeLock(lock: RuntimeLock): Promise<void> {
  await lock.handle.close();

  let existing: unknown;
  try {
    existing = JSON.parse(await readFile(lock.path, "utf8"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return;
    }
    throw error;
  }

  if (
    existing
    && typeof existing === "object"
    && "ownerId" in existing
    && existing.ownerId === lock.ownerId
  ) {
    await rm(lock.path);
  }
}

export async function writeRuntimeConfig(path: string, config: RuntimeConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

export async function removeOwnedRuntimeConfig(
  path: string,
  expected: Pick<RuntimeConfig, "pid" | "port">,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return;
    }
    throw error;
  }

  if (
    parsed
    && typeof parsed === "object"
    && "pid" in parsed
    && "port" in parsed
    && parsed.pid === expected.pid
    && parsed.port === expected.port
  ) {
    await rm(path);
  }
}
