import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  hookEvents,
  installCodexHooks,
  installCopilotHooks,
  uninstallCodexHooks,
  uninstallCopilotHooks,
} from "./index.js";

const RUNNER_PATH = process.execPath;

test("Copilot upgrade removes only owned legacy approvals and installs notifications idempotently", async context => {
  const homeDir = await temporaryHome(context);
  const path = join(homeDir, ".copilot", "hooks", "vibemate.json");
  await mkdir(join(homeDir, ".copilot", "hooks"), { recursive: true });
  const user = { type: "command", bash: "user-policy" };
  const legacy = { type: "command", bash: "node old-runner copilot permissionRequest --vibemate-hook-runner" };
  await writeFile(path, JSON.stringify({ version: 1, hooks: {
    permissionRequest: [legacy, user],
    PermissionRequest: [{ matcher: "Bash", hooks: [{ command: "user-policy" }, { command: "old --vibemate-hook-runner" }] }],
  } }));
  const first = await installCopilotHooks({ homeDir, runnerPath: RUNNER_PATH });
  assert.ok(first.backupPath);
  const hooks = (await readJson(path)).hooks as Record<string, unknown[]>;
  assert.deepEqual(hooks.permissionRequest, [user]);
  assert.deepEqual(hooks.PermissionRequest, [{ matcher: "Bash", hooks: [{ command: "user-policy" }] }]);
  assert.equal((hooks.notification?.[0] as { matcher: string }).matcher, "permission_prompt");
  const second = await installCopilotHooks({ homeDir, runnerPath: RUNNER_PATH });
  assert.equal(second.changed, false);
});

async function temporaryHome(context: test.TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "vibemate-installer-"));
  context.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

test("Codex installation preserves user hooks and is idempotent", async (context) => {
  const homeDir = await temporaryHome(context);
  const codexHome = join(homeDir, ".codex");
  const configPath = join(codexHome, "hooks.json");
  await mkdir(codexHome, { recursive: true });
  const userHook = {
    hooks: [{ type: "command", command: "/usr/local/bin/user-hook" }],
  };
  await writeFile(configPath, JSON.stringify({
    custom: true,
    hooks: { SessionStart: [userHook] },
  }));

  const first = await installCodexHooks({
    homeDir,
    runnerPath: RUNNER_PATH,
    nodePath: process.execPath,
  });
  assert.equal(first.added, hookEvents.codex.length);
  assert.equal(first.changed, true);
  assert.ok(first.backupPath);
  await access(first.backupPath);

  const installed = await readJson(configPath);
  assert.equal(installed.custom, true);
  const hooks = installed.hooks as Record<string, unknown[]>;
  assert.deepEqual(hooks.SessionStart?.[0], userHook);
  assert.equal(hooks.SessionStart?.length, 2);

  const second = await installCodexHooks({
    homeDir,
    runnerPath: RUNNER_PATH,
    nodePath: process.execPath,
  });
  assert.equal(second.changed, false);
  assert.equal(second.unchanged, hookEvents.codex.length);
  assert.equal(second.backupPath, undefined);
});

test("Copilot installation uses a dedicated config file", async (context) => {
  const homeDir = await temporaryHome(context);
  const result = await installCopilotHooks({
    homeDir,
    runnerPath: RUNNER_PATH,
    nodePath: process.execPath,
  });

  assert.equal(result.changed, true);
  assert.equal(result.permissionInstalled, false);
  assert.equal(result.added, hookEvents.copilot.length);
  const installed = await readJson(result.configPath);
  assert.equal(installed.version, 1);
  const hooks = installed.hooks as Record<string, unknown[]>;
  assert.equal(hooks.permissionRequest, undefined);
  assert.equal(hooks.notification?.length, 1);
  assert.equal(hooks.sessionStart?.length, 1);
});

test("packaged desktop hooks enable Electron's Node mode", async (context) => {
  const homeDir = await temporaryHome(context);
  const codex = await installCodexHooks({
    homeDir, runnerPath: RUNNER_PATH, nodePath: process.execPath,
    platform: "win32", electronAsNode: true,
  });
  const codexConfig = await readJson(codex.configPath);
  const codexHooks = codexConfig.hooks as Record<string, Array<{ hooks: Array<{ commandWindows: string }> }>>;
  assert.match(codexHooks.SessionStart?.[0]?.hooks[0]?.commandWindows ?? "", /ELECTRON_RUN_AS_NODE/);

  const copilot = await installCopilotHooks({
    homeDir, runnerPath: RUNNER_PATH, nodePath: process.execPath,
    platform: "win32", electronAsNode: true,
  });
  const copilotConfig = await readJson(copilot.configPath);
  const copilotHooks = copilotConfig.hooks as Record<string, Array<{ powershell: string }>>;
  assert.match(copilotHooks.sessionStart?.[0]?.powershell ?? "", /ELECTRON_RUN_AS_NODE/);
});

test("Copilot monitoring leaves third-party permission hooks untouched", async (context) => {
  const homeDir = await temporaryHome(context);
  const hooksDirectory = join(homeDir, ".copilot", "hooks");
  const userConfigPath = join(hooksDirectory, "security.json");
  await mkdir(hooksDirectory, { recursive: true });
  await writeFile(userConfigPath, JSON.stringify({
    version: 1,
    hooks: {
      permissionRequest: [{
        type: "command",
        bash: "/usr/local/bin/security-hook",
      }],
    },
  }));

  const result = await installCopilotHooks({
    homeDir,
    runnerPath: RUNNER_PATH,
    nodePath: process.execPath,
  });
  assert.equal(result.permissionInstalled, false);
  assert.deepEqual(result.warnings, []);

  const installed = await readJson(result.configPath);
  const hooks = installed.hooks as Record<string, unknown[]>;
  assert.equal(hooks.permissionRequest, undefined);
  assert.equal(hooks.sessionStart?.length, 1);
  assert.equal(await readFile(userConfigPath, "utf8"), JSON.stringify({
    version: 1,
    hooks: {
      permissionRequest: [{
        type: "command",
        bash: "/usr/local/bin/security-hook",
      }],
    },
  }));
});

test("malformed existing config is never overwritten", async (context) => {
  const homeDir = await temporaryHome(context);
  const codexHome = join(homeDir, ".codex");
  const configPath = join(codexHome, "hooks.json");
  await mkdir(codexHome, { recursive: true });
  await writeFile(configPath, "{ invalid");

  await assert.rejects(() => installCodexHooks({
    homeDir,
    runnerPath: RUNNER_PATH,
    nodePath: process.execPath,
  }), /invalid JSON/);
  assert.equal(await readFile(configPath, "utf8"), "{ invalid");
});

test("uninstall removes only VibeMate-managed entries", async (context) => {
  const homeDir = await temporaryHome(context);
  const userCodexHook = {
    hooks: [{ type: "command", command: "/usr/local/bin/user-hook" }],
  };
  const userCopilotHook = {
    type: "command",
    bash: "/usr/local/bin/user-hook",
  };

  await installCodexHooks({
    homeDir,
    runnerPath: RUNNER_PATH,
    nodePath: process.execPath,
  });
  await installCopilotHooks({
    homeDir,
    runnerPath: RUNNER_PATH,
    nodePath: process.execPath,
  });

  const codexPath = join(homeDir, ".codex", "hooks.json");
  const codex = await readJson(codexPath);
  (codex.hooks as Record<string, unknown[]>).SessionStart?.unshift(userCodexHook);
  await writeFile(codexPath, JSON.stringify(codex));

  const copilotPath = join(homeDir, ".copilot", "hooks", "vibemate.json");
  const copilot = await readJson(copilotPath);
  (copilot.hooks as Record<string, unknown[]>).sessionStart?.unshift(userCopilotHook);
  await writeFile(copilotPath, JSON.stringify(copilot));

  const codexResult = await uninstallCodexHooks({ homeDir });
  const copilotResult = await uninstallCopilotHooks({ homeDir });
  assert.equal(codexResult.removed, hookEvents.codex.length);
  assert.equal(copilotResult.removed, hookEvents.copilot.length);

  const remainingCodex = await readJson(codexPath);
  assert.deepEqual(
    (remainingCodex.hooks as Record<string, unknown[]>).SessionStart,
    [userCodexHook],
  );
  const remainingCopilot = await readJson(copilotPath);
  assert.deepEqual(
    (remainingCopilot.hooks as Record<string, unknown[]>).sessionStart,
    [userCopilotHook],
  );
});
