import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
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
  "permissionRequest",
] as const;

type JsonObject = Record<string, unknown>;

export interface InstallOptions {
  homeDir?: string;
  codexHome?: string;
  copilotHome?: string;
  runnerPath?: string;
  nodePath?: string;
  platform?: NodeJS.Platform;
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
): { command: string; commandWindows?: string } {
  const argumentsText = `${shellQuote(runnerPath)} codex --${MARKER}`;
  if (platform === "win32") {
    const commandWindows = `& ${powershellQuote(nodePath)} ${powershellQuote(runnerPath)} codex --${MARKER}`;
    return {
      command: `${shellQuote(nodePath)} ${argumentsText}`,
      commandWindows,
    };
  }
  return { command: `${shellQuote(nodePath)} ${argumentsText}` };
}

function copilotCommand(
  nodePath: string,
  runnerPath: string,
  event: string,
): { type: "command"; bash: string; powershell: string; timeoutSec: number } {
  return {
    type: "command",
    bash: `${shellQuote(nodePath)} ${shellQuote(runnerPath)} copilot ${shellQuote(event)} --${MARKER}`,
    powershell: `& ${powershellQuote(nodePath)} ${powershellQuote(runnerPath)} copilot ${powershellQuote(event)} --${MARKER}`,
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

async function fileDeclaresPermissionHook(path: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(stripBom(await readFile(path, "utf8")));
    if (!isObject(parsed) || !isObject(parsed.hooks)) {
      return false;
    }
    return Array.isArray(parsed.hooks.permissionRequest)
      && parsed.hooks.permissionRequest.length > 0;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    return true;
  }
}

async function findCopilotPermissionConflict(
  copilotHome: string,
  targetPath: string,
  targetHooks: JsonObject,
): Promise<string | undefined> {
  const targetPermission = targetHooks.permissionRequest;
  if (
    Array.isArray(targetPermission)
    && targetPermission.some((entry) => !commandContainsMarker(entry))
  ) {
    return targetPath;
  }

  const hooksDirectory = join(copilotHome, "hooks");
  try {
    const entries = await readdir(hooksDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(hooksDirectory, entry.name);
      if (
        (entry.isFile() || entry.isSymbolicLink())
        && entry.name.endsWith(".json")
        && resolve(path) !== resolve(targetPath)
        && await fileDeclaresPermissionHook(path)
      ) {
        return path;
      }
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      return hooksDirectory;
    }
  }

  const settingsPath = join(copilotHome, "settings.json");
  try {
    if (await fileDeclaresPermissionHook(settingsPath)) {
      return settingsPath;
    }
  } catch {
    return settingsPath;
  }
  return undefined;
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
  const permissionConflict = await findCopilotPermissionConflict(home, configPath, hooks);
  const result: InstallResult = {
    configPath,
    added: 0,
    updated: 0,
    unchanged: 0,
    permissionInstalled: !permissionConflict,
    changed: false,
    warnings: [],
  };

  for (const event of COPILOT_EVENTS) {
    const existing = hooks[event];
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new Error(`${configPath}: hooks.${event} must be an array`);
    }
    if (event === "permissionRequest" && permissionConflict) {
      hooks[event] = (existing ?? []).filter((entry) => !commandContainsMarker(entry));
      result.warnings.push(
        `permissionRequest not installed because another hook exists in ${permissionConflict}`,
      );
      continue;
    }
    const reconciled = reconcileEntry(
      existing ?? [],
      copilotCommand(nodePath, runnerPath, event),
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
    COPILOT_EVENTS,
    commandContainsMarker,
  );
}

export const hookEvents = {
  codex: CODEX_EVENTS,
  copilot: COPILOT_EVENTS,
} as const;
