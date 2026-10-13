import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "vibemate-hook-runner";
const CODEX_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "Stop",
] as const;
const COPILOT_EVENTS = [
  "sessionStart",
  "userPromptSubmitted",
  "preToolUse",
  "postToolUse",
  "sessionEnd",
  "errorOccurred",
  "agentStop",
  "subagentStart",
  "subagentStop",
  "preCompact",
  "notification",
] as const;

type JsonObject = Record<string, unknown>;

export interface InstallOptions {
  homeDir?: string;
  codexHome?: string;
  copilotHome?: string;
  runnerPath?: string;
  nodePath?: string;
  platform?: NodeJS.Platform;
  electronAsNode?: boolean;
}

export interface InstallResult {
  configPath: string;
  added: number;
  updated: number;
  unchanged: number;
  permissionInstalled: boolean;
  changed: boolean;
  backupPath?: string;
  warnings: string[];
}

export interface UninstallResult {
  configPath: string;
  removed: number;
  changed: boolean;
  backupPath?: string;
}

interface JsonFile {
  exists: boolean;
  value: JsonObject;
  mode: number;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function commandContainsMarker(entry: unknown): boolean {
  if (!isObject(entry)) {
    return false;
  }
  for (const field of ["command", "commandWindows", "bash", "powershell"]) {
    if (typeof entry[field] === "string" && entry[field].includes(MARKER)) {
      return true;
    }
  }
  return false;
}

function codexGroupContainsMarker(entry: unknown): boolean {
  if (!isObject(entry) || !Array.isArray(entry.hooks)) {
    return false;
  }
  return entry.hooks.some(commandContainsMarker);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function ensureHooks(value: JsonObject, path: string): JsonObject {
  if (value.hooks === undefined) {
    const hooks = {};
    value.hooks = hooks;
    return hooks;
  }
  if (!isObject(value.hooks)) {
    throw new Error(`${path}: hooks must be an object`);
  }
  return value.hooks;
}

async function readJsonObject(path: string, defaultValue: JsonObject): Promise<JsonFile> {
  try {
    const [text, metadata] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    const parsed: unknown = JSON.parse(stripBom(text));
    if (!isObject(parsed)) {
      throw new Error(`${path}: root must be a JSON object`);
    }
    return {
      exists: true,
      value: parsed,
      mode: metadata.mode & 0o777,
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { exists: false, value: structuredClone(defaultValue), mode: 0o600 };
    }
    if (error instanceof SyntaxError) {
      throw new Error(`${path}: invalid JSON`, { cause: error });
    }
    throw error;
  }
}

async function writeJsonAtomic(path: string, file: JsonFile): Promise<string | undefined> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let backupPath: string | undefined;
  if (file.exists) {
    backupPath = `${path}.vibemate-${Date.now()}-${randomUUID()}.bak`;
    await copyFile(path, backupPath, constants.COPYFILE_EXCL);
    await chmod(backupPath, file.mode);
  }

  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporaryPath, "wx", file.mode);
    try {
      await handle.writeFile(`${JSON.stringify(file.value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return backupPath;
}

function defaultRunnerPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../hook-runner/dist/cli.js");
}

async function resolveExecutables(options: InstallOptions): Promise<{
  nodePath: string;
  runnerPath: string;
}> {
  const nodePath = resolve(options.nodePath ?? process.execPath);
  const runnerPath = resolve(options.runnerPath ?? defaultRunnerPath());
  await Promise.all([access(nodePath, constants.X_OK), access(runnerPath, constants.R_OK)]);
  return { nodePath, runnerPath };
}

function codexCommand(
  nodePath: string,
  runnerPath: string,
  platform: NodeJS.Platform,
  electronAsNode = false,
): { command: string; commandWindows?: string } {
  const prefix = electronAsNode ? "ELECTRON_RUN_AS_NODE=1 " : "";
  const argumentsText = `${shellQuote(runnerPath)} codex --${MARKER}`;
  if (platform === "win32") {
    const electronEnvironment = electronAsNode ? "$env:ELECTRON_RUN_AS_NODE = '1'; " : "";
    const commandWindows = `${electronEnvironment}& ${powershellQuote(nodePath)} ${powershellQuote(runnerPath)} codex --${MARKER}`;
    return {
      command: `${prefix}${shellQuote(nodePath)} ${argumentsText}`,
      commandWindows,
    };
  }
  return { command: `${prefix}${shellQuote(nodePath)} ${argumentsText}` };
}

function copilotCommand(
  nodePath: string,
  runnerPath: string,
  event: string,
  electronAsNode = false,
): { type: "command"; bash: string; powershell: string; timeoutSec: number } {
  return {
    type: "command",
    bash: `${electronAsNode ? "ELECTRON_RUN_AS_NODE=1 " : ""}${shellQuote(nodePath)} ${shellQuote(runnerPath)} copilot ${shellQuote(event)} --${MARKER}`,
    powershell: `${electronAsNode ? "$env:ELECTRON_RUN_AS_NODE = '1'; " : ""}& ${powershellQuote(nodePath)} ${powershellQuote(runnerPath)} copilot ${powershellQuote(event)} --${MARKER}`,
    timeoutSec: event === "permissionRequest" ? 600 : 5,
  };
}

function reconcileEntry(
  entries: unknown[],
  desired: unknown,
  isManaged: (entry: unknown) => boolean,
): { entries: unknown[]; status: "added" | "updated" | "unchanged" } {
  const managed = entries.filter(isManaged);
  if (managed.length === 1 && valuesEqual(managed[0], desired)) {
    return { entries, status: "unchanged" };
  }
  const retained = entries.filter((entry) => !isManaged(entry));
  return {
    entries: [...retained, desired],
    status: managed.length > 0 ? "updated" : "added",
  };
}

function countStatus(
  result: Pick<InstallResult, "added" | "updated" | "unchanged">,
  status: "added" | "updated" | "unchanged",
): void {
  result[status]++;
}

function removeLegacyCopilotPermissions(hooks: JsonObject, configPath: string): void {
  // Upgrade only our entries in the dedicated file; preserve third-party policies.
  for (const legacyEvent of ["permissionRequest", "PermissionRequest"]) {
    const entries = hooks[legacyEvent];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) throw new Error(`${configPath}: hooks.${legacyEvent} must be an array`);
    hooks[legacyEvent] = entries.flatMap(entry => {
      if (commandContainsMarker(entry)) return [];
      if (isObject(entry) && Array.isArray(entry.hooks) && codexGroupContainsMarker(entry)) {
        const retained = entry.hooks.filter(hook => !commandContainsMarker(hook));
        return retained.length ? [{ ...entry, hooks: retained }] : [];
      }
      return [entry];
    });
  }
}

export async function installCodexHooks(
  options: InstallOptions = {},
): Promise<InstallResult> {
  const { nodePath, runnerPath } = await resolveExecutables(options);
  const home = options.codexHome
    ?? process.env.CODEX_HOME
    ?? join(options.homeDir ?? homedir(), ".codex");
  const configPath = join(home, "hooks.json");
  const file = await readJsonObject(configPath, {});
  const original = JSON.stringify(file.value);
  const hooks = ensureHooks(file.value, configPath);
  const result: InstallResult = {
    configPath,
    added: 0,
    updated: 0,
    unchanged: 0,
    permissionInstalled: true,
    changed: false,
    warnings: [],
  };
  const commands = codexCommand(
    nodePath,
    runnerPath,
    options.platform ?? process.platform,
    options.electronAsNode,
  );

  for (const event of CODEX_EVENTS) {
    const existing = hooks[event];
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new Error(`${configPath}: hooks.${event} must be an array`);
    }
    const desired = {
      hooks: [{
        type: "command",
        ...commands,
        timeout: event === "PermissionRequest" ? 600 : 30,
      }],
    };
    const reconciled = reconcileEntry(
      existing ?? [],
      desired,
      codexGroupContainsMarker,
    );
    hooks[event] = reconciled.entries;
    countStatus(result, reconciled.status);
  }

  result.changed = original !== JSON.stringify(file.value);
  if (result.changed) {
    const backupPath = await writeJsonAtomic(configPath, file);
    if (backupPath) {
      result.backupPath = backupPath;
    }
  }
  return result;
}

export async function installCopilotHooks(
  options: InstallOptions = {},
): Promise<InstallResult> {
  const { nodePath, runnerPath } = await resolveExecutables(options);
  const home = options.copilotHome
    ?? process.env.COPILOT_HOME
    ?? join(options.homeDir ?? homedir(), ".copilot");
  const configPath = join(home, "hooks", "vibemate.json");
  const file = await readJsonObject(configPath, { version: 1, hooks: {} });
  const original = JSON.stringify(file.value);
  if (file.value.version === undefined) {
    file.value.version = 1;
  } else if (file.value.version !== 1) {
    throw new Error(`${configPath}: unsupported hook config version`);
  }
  const hooks = ensureHooks(file.value, configPath);
  removeLegacyCopilotPermissions(hooks, configPath);
  const result: InstallResult = {
    configPath,
    added: 0,
    updated: 0,
    unchanged: 0,
    permissionInstalled: false,
    changed: false,
    warnings: [],
  };

  for (const event of COPILOT_EVENTS) {
    const existing = hooks[event];
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new Error(`${configPath}: hooks.${event} must be an array`);
    }
    const reconciled = reconcileEntry(
      existing ?? [],
      { ...copilotCommand(nodePath, runnerPath, event, options.electronAsNode),
        ...(event === "notification" ? { matcher: "permission_prompt" } : {}) },
      commandContainsMarker,
    );
    hooks[event] = reconciled.entries;
    countStatus(result, reconciled.status);
  }

  result.changed = original !== JSON.stringify(file.value);
  if (result.changed) {
    const backupPath = await writeJsonAtomic(configPath, file);
    if (backupPath) {
      result.backupPath = backupPath;
    }
  }
  return result;
}

async function uninstallHooks(
  configPath: string,
  events: readonly string[],
  isManaged: (entry: unknown) => boolean,
): Promise<UninstallResult> {
  const file = await readJsonObject(configPath, {});
  const result: UninstallResult = {
    configPath,
    removed: 0,
    changed: false,
  };
  if (!file.exists || file.value.hooks === undefined) {
    return result;
  }
  if (!isObject(file.value.hooks)) {
    throw new Error(`${configPath}: hooks must be an object`);
  }

  const original = JSON.stringify(file.value);
  for (const event of events) {
    const existing = file.value.hooks[event];
    if (existing === undefined) {
      continue;
    }
    if (!Array.isArray(existing)) {
      throw new Error(`${configPath}: hooks.${event} must be an array`);
    }
    const retained = existing.filter((entry) => !isManaged(entry));
    result.removed += existing.length - retained.length;
    if (retained.length === 0) {
      delete file.value.hooks[event];
    } else {
      file.value.hooks[event] = retained;
    }
  }

  result.changed = original !== JSON.stringify(file.value);
  if (result.changed) {
    const backupPath = await writeJsonAtomic(configPath, file);
    if (backupPath) {
      result.backupPath = backupPath;
    }
  }
  return result;
}

export async function uninstallCodexHooks(
  options: InstallOptions = {},
): Promise<UninstallResult> {
  const home = options.codexHome
    ?? process.env.CODEX_HOME
    ?? join(options.homeDir ?? homedir(), ".codex");
  return uninstallHooks(
    join(home, "hooks.json"),
    CODEX_EVENTS,
    codexGroupContainsMarker,
  );
}

export async function uninstallCopilotHooks(
  options: InstallOptions = {},
): Promise<UninstallResult> {
  const home = options.copilotHome
    ?? process.env.COPILOT_HOME
    ?? join(options.homeDir ?? homedir(), ".copilot");
  return uninstallHooks(
    join(home, "hooks", "vibemate.json"),
    [...COPILOT_EVENTS, "permissionRequest", "PermissionRequest"],
    commandContainsMarker,
  );
}

export const hookEvents = {
  codex: CODEX_EVENTS,
  copilot: COPILOT_EVENTS,
} as const;
