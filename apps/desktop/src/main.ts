import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  Tray,
  type IpcMainInvokeEvent,
} from "electron";
import { installCodexHooks, installCopilotHooks } from "@vibemate/hook-installer";
import { discoverSshHosts, discoverWsl } from "./environment-discovery.js";
import { EnvironmentStore } from "./environment-store.js";
import type { DesktopConfiguration, EnvironmentConfig } from "./environment-types.js";
import { ManagedEnvironmentLauncher } from "./managed-environment-launcher.js";
import { ReceiverConnectionManager } from "./receiver-connection-manager.js";
import { ManualSshLauncher } from "./manual-ssh-launcher.js";
import { connectionKey, parseSshCredentials, parseSshDeviceInput, SshConnectionService } from "./ssh-connection.js";
import { configureSshEnvironment, previousFingerprint } from "./ssh-environment-settings.js";
import { PetWindow } from "./pet-window.js";
import { parseReminderState, ReminderWindow } from "./reminder-window.js";
import { WindowPositionStore } from "./window-position.js";
import { describeNotice, TaskNotifier, type TaskNotice } from "./task-notifier.js";

const sourceDirectory = fileURLToPath(new URL(".", import.meta.url));
const rendererDirectory = join(sourceDirectory, "../src/renderer");
const preloadPath = join(sourceDirectory, "../src/preload.cjs");

function hookRunnerPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "app", "hook-runner", "cli.js")
    : fileURLToPath(new URL("../../../packages/hook-runner/dist/cli.js", import.meta.url));
}

async function installWindowsHooks(): Promise<void> {
  const options = {
    runnerPath: hookRunnerPath(), nodePath: process.execPath, platform: process.platform,
    electronAsNode: app.isPackaged,
  };
  const results = await Promise.allSettled([installCodexHooks(options), installCopilotHooks(options)]);
  if (results.every((result) => result.status === "rejected")) {
    const first = results[0];
    throw first?.status === "rejected" ? first.reason : new Error("Agent Hook 安装失败");
  }
  for (const result of results) {
    if (result.status === "rejected") console.error("Optional Agent hook install failed:", result.reason);
  }
}

let configuration: DesktopConfiguration;
let environmentStore: EnvironmentStore;
let receiverManager: ReceiverConnectionManager;
const sshConnections = new SshConnectionService(async ({ host, port, fingerprint }) => {
  const options = {
    type: "question" as const,
    title: "确认设备身份",
    message: `首次连接 ${host}:${port}，是否信任这台设备？`,
    detail: `设备指纹：\n${fingerprint}\n\n请与设备管理者核对。确认后将保存此设备身份，身份改变时会停止连接。`,
    buttons: ["取消", "信任并继续"], defaultId: 0, cancelId: 0,
  };
  const result = controlWindow ? await dialog.showMessageBox(controlWindow, options) : await dialog.showMessageBox(options);
  return result.response === 1;
});

let controlWindow: BrowserWindow | undefined;
const positions = new WindowPositionStore(app.getPath("userData"));
const reminder = new ReminderWindow(positions, {
  preload: preloadPath, page: join(rendererDirectory, "preview.html"), onLoad: () => publishSnapshot(),
});
const pet = new PetWindow(positions, {
  preload: preloadPath, page: join(rendererDirectory, "pet.html"), onLoad: () => publishSnapshot(),
});
let tray: Tray | undefined;
let snapshotScheduled = false;
let quitting = false;

function getSnapshot() {
  return receiverManager?.getSnapshot() ?? {
    devices: [], environments: [], sessions: [], pendingPermissions: [],
    preferences: { petEnabled: false, showPet: true, showPreview: true, systemNotifications: true, focus: { kind: "all" as const } },
    onboardingCompleted: false,
  };
}

function publishSnapshot(): void {
  const snapshot = getSnapshot();
  for (const window of [controlWindow, pet.window, reminder.window]) {
    if (window && !window.isDestroyed()) {
      window.webContents.send("vibemate:snapshot", snapshot);
    }
  }
}

const taskNotifier = new TaskNotifier();

function scheduleSnapshot(): void {
  if (snapshotScheduled) {
    return;
  }
  snapshotScheduled = true;
  queueMicrotask(() => {
    snapshotScheduled = false;
    publishSnapshot();
    for (const notice of taskNotifier.diff(getSnapshot())) deliverNotice(notice);
  });
}

function deliverNotice(notice: TaskNotice): void {
  const window = reminder.window;
  if (window && !window.isDestroyed()) window.webContents.send("vibemate:notice", notice);
  if (!configuration.preferences.systemNotifications || !Notification.isSupported()) return;
  const { title, body } = describeNotice(notice);
  const toast = new Notification({ title, body, silent: notice.kind === "completed" });
  toast.on("click", () => {
    const target = reminder.window;
    if (!target || target.isDestroyed()) return;
    if (!target.isVisible()) togglePreviewWindow();
    target.webContents.send("vibemate:notice", { ...notice, expand: true });
  });
  toast.show();
}

function createControlWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 460,
    height: 600,
    minWidth: 380,
    minHeight: 480,
    show: !configuration?.onboardingCompleted,
    title: "VibeMate 设置",
    backgroundColor: "#111827",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void window.loadFile(join(rendererDirectory, "index.html"));
  window.webContents.once("did-finish-load", publishSnapshot);
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on("closed", () => {
    if (controlWindow === window) {
      controlWindow = undefined;
    }
  });
  return window;
}

function togglePreviewWindow(): void {
  const window = reminder.window;
  if (!window) return;
  if (window.isVisible()) window.hide();
  else window.showInactive();
  configuration.preferences.showPreview = window.isVisible();
  void environmentStore.save(configuration).catch((error: unknown) => console.error("Could not save preview preference:", error));
  updateTrayMenu();
}

function showControlWindow(): void {
  if (!controlWindow) {
    controlWindow = createControlWindow();
  }
  controlWindow.show();
  controlWindow.focus();
}

async function setPetEnabled(enabled: boolean): Promise<void> {
  configuration.preferences.petEnabled = enabled;
  if (enabled) {
    configuration.preferences.showPet = true;
    (await pet.create(true)).showInactive();
  } else {
    await pet.destroy();
  }
  await environmentStore.save(configuration);
  receiverManager.setConfiguration(configuration);
  updateTrayMenu();
}

function togglePetWindow(): void {
  const window = pet.window;
  if (!window) {
    return;
  }
  if (window.isVisible()) {
    window.hide();
  } else {
    window.showInactive();
  }
  configuration.preferences.showPet = window.isVisible();
  void environmentStore.save(configuration).catch((error: unknown) => console.error("Could not save pet preference:", error));
  updateTrayMenu();
}

function createTrayIcon() {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">',
    '<rect x="3" y="5" width="26" height="24" rx="9" fill="#60a5fa"/>',
    '<rect x="9" y="14" width="4" height="6" rx="2" fill="#0f172a"/>',
    '<rect x="19" y="14" width="4" height="6" rx="2" fill="#0f172a"/>',
    '<path d="M16 5V2" stroke="#0f172a" stroke-width="3" stroke-linecap="round"/>',
    "</svg>",
  ].join("");
  return nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
  ).resize({ width: 20, height: 20 });
}

function updateTrayMenu(): void {
  if (!tray) {
    return;
  }
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: reminder.window?.isVisible() ? "隐藏悬浮提醒窗" : "显示悬浮提醒窗",
      click: togglePreviewWindow,
    },
    {
      label: "设置…",
      click: showControlWindow,
    },
    ...(pet.window ? [{
      label: pet.window.isVisible() ? "隐藏桌宠" : "显示桌宠",
      click: togglePetWindow,
    }] : []),
    { type: "separator" },
    {
      label: "退出 VibeMate",
      click: () => app.quit(),
    },
  ]));
}

function createTray(): Tray {
  const nextTray = new Tray(createTrayIcon());
  nextTray.setToolTip("VibeMate");
  nextTray.on("click", showControlWindow);
  tray = nextTray;
  updateTrayMenu();
  return nextTray;
}

ipcMain.handle("vibemate:get-snapshot", () => getSnapshot());
ipcMain.on("vibemate:hide-preview", (event) => {
  if (event.sender !== reminder.window?.webContents) return;
  if (reminder.window.isVisible()) togglePreviewWindow();
});
ipcMain.on("vibemate:preview-state", (event, value: unknown) => {
  if (event.sender !== reminder.window?.webContents) return;
  const state = parseReminderState(value);
  if (state) reminder.setState(state);
});
ipcMain.on("vibemate:preview-drag", (event, phase: unknown, dx: unknown, dy: unknown) => {
  if (event.sender !== reminder.window?.webContents) return;
  if ((phase !== "start" && phase !== "move" && phase !== "end")
    || typeof dx !== "number" || typeof dy !== "number" || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
  reminder.drag(phase, dx, dy);
});
ipcMain.handle("vibemate:set-codex-approvals", async (_event, environmentId: unknown, enabled: unknown) => {
  if (typeof environmentId !== "string" || typeof enabled !== "boolean") throw new TypeError("invalid approval setting");
  const environment = configuration.environments.find(item => item.environmentId === environmentId);
  if (!environment) throw new Error("environment not found");
  await receiverManager.setCodexApprovals(environmentId, enabled);
  const previous = environment.codexApprovalsEnabled === true;
  environment.codexApprovalsEnabled = enabled;
  try { await environmentStore.save(configuration); }
  catch (error) {
    environment.codexApprovalsEnabled = previous;
    await receiverManager.setCodexApprovals(environmentId, previous);
    throw error;
  }
  receiverManager.setConfiguration(configuration);
  return getSnapshot();
});
ipcMain.on("vibemate:show-control", showControlWindow);
ipcMain.on("vibemate:quit", () => app.quit());
ipcMain.handle(
  "vibemate:submit-decision",
  (_event, identity: unknown, decision: unknown) => {
    if (
      !identity
      || typeof identity !== "object"
      || !("environmentId" in identity)
      || !("requestId" in identity)
      || !("sourceProfile" in identity)
      || !("agent" in identity)
      || !("sessionId" in identity)
      || typeof identity.environmentId !== "string"
      || typeof identity.requestId !== "string"
      || typeof identity.sourceProfile !== "string"
      || (identity.agent !== "codex" && identity.agent !== "copilot")
      || typeof identity.sessionId !== "string"
      || (decision !== "allow" && decision !== "deny")
    ) {
      throw new TypeError("invalid permission decision");
    }
    return receiverManager.submitDecision({
      environmentId: identity.environmentId,
      requestId: identity.requestId,
      sourceProfile: identity.sourceProfile,
      agent: identity.agent,
      sessionId: identity.sessionId,
    }, decision);
  },
);

ipcMain.handle("vibemate:scan-environments", async () => {
  const localDevice = configuration.devices.find((device) => device.kind === "local");
  if (!localDevice) throw new Error("local device is missing");
  const [wsl, sshHosts] = await Promise.all([discoverWsl(), discoverSshHosts()]);
  const discovered: EnvironmentConfig[] = [
    ...wsl.map((distribution): EnvironmentConfig => ({
      environmentId: randomUUID(), deviceId: localDevice.deviceId,
      name: `WSL · ${distribution.name}`, kind: "wsl", enabled: false,
      distribution: distribution.name,
    })),
    ...sshHosts.map((sshHost): EnvironmentConfig => {
      let device = configuration.devices.find((item) => item.kind === "remote" && item.name === sshHost);
      if (!device) {
        device = { deviceId: randomUUID(), name: sshHost, kind: "remote" };
        configuration.devices.push(device);
      }
      return { environmentId: randomUUID(), deviceId: device.deviceId, name: sshHost, kind: "ssh", enabled: false, sshHost };
    }),
  ];
  configuration.environments = EnvironmentStore.mergeDiscovered(configuration.environments, discovered);
  receiverManager.setConfiguration(configuration);
  await environmentStore.save(configuration);
  return getSnapshot();
});

ipcMain.handle("vibemate:set-environment-enabled", async (_event, environmentId: unknown, enabled: unknown) => {
  if (typeof environmentId !== "string" || typeof enabled !== "boolean") throw new TypeError("invalid environment setting");
  const environment = configuration.environments.find((item) => item.environmentId === environmentId);
  if (!environment) throw new Error("environment not found");
  if (enabled && environment.kind === "windows") {
    await installWindowsHooks();
    await receiverManager.start(environmentId, true);
  }
  if (!enabled) await receiverManager.stop(environmentId);
  environment.enabled = enabled;
  configuration.onboardingCompleted = true;
  await environmentStore.save(configuration);
  receiverManager.setConfiguration(configuration);
  return getSnapshot();
});

ipcMain.handle("vibemate:start-environment", async (_event, environmentId: unknown) => {
  if (typeof environmentId !== "string") throw new TypeError("invalid environment id");
  await receiverManager.start(environmentId, true);
  const environment = configuration.environments.find((item) => item.environmentId === environmentId);
  if (environment) {
    environment.enabled = true;
    configuration.onboardingCompleted = true;
    await environmentStore.save(configuration);
    receiverManager.setConfiguration(configuration);
  }
  return getSnapshot();
});

ipcMain.handle("vibemate:stop-environment", async (_event, environmentId: unknown) => {
  if (typeof environmentId !== "string") throw new TypeError("invalid environment id");
  await receiverManager.stop(environmentId);
  const environment = configuration.environments.find((item) => item.environmentId === environmentId);
  if (environment?.kind !== "ssh" && environment) {
    environment.enabled = false;
    await environmentStore.save(configuration);
    receiverManager.setConfiguration(configuration);
  }
  return getSnapshot();
});

ipcMain.handle("vibemate:add-ssh-environment", async (_event, value: unknown) => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9._-]{1,255}$/.test(value)) {
    throw new TypeError("请输入 ~/.ssh/config 中的主机别名");
  }
  let device = configuration.devices.find((item) => item.kind === "remote" && item.name === value);
  if (!device) {
    device = { deviceId: randomUUID(), name: value, kind: "remote" };
    configuration.devices.push(device);
  }
  if (!configuration.environments.some((item) => item.kind === "ssh" && item.sshHost.toLowerCase() === value.toLowerCase())) {
    configuration.environments.push({ environmentId: randomUUID(), deviceId: device.deviceId, name: value, kind: "ssh", enabled: false, sshHost: value });
  }
  await environmentStore.save(configuration);
  receiverManager.setConfiguration(configuration);
  return getSnapshot();
});

function settingsInput(event: IpcMainInvokeEvent, value: unknown): Record<string, unknown> {
  if (!controlWindow || event.sender !== controlWindow.webContents) throw new Error("请从 VibeMate 设置页配置设备");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("设备信息格式不正确");
  return value as Record<string, unknown>;
}

ipcMain.handle("vibemate:pick-private-key", async (event) => {
  settingsInput(event, {});
  const result = await dialog.showOpenDialog(controlWindow!, { title: "选择 SSH 私钥文件", properties: ["openFile"] });
  return result.canceled ? undefined : result.filePaths[0];
});

ipcMain.handle("vibemate:test-ssh-connection", async (event, value: unknown) => {
  const input = settingsInput(event, value);
  const profile = parseSshDeviceInput(input.profile);
  if (input.environmentId !== undefined && typeof input.environmentId !== "string") throw new TypeError("设备编号不正确");
  const existing = configuration.environments.find(item => input.environmentId
    ? item.environmentId === input.environmentId
    : item.kind === "ssh" && item.sshConnection?.host.toLowerCase() === profile.host.toLowerCase() && item.sshConnection.port === profile.port);
  if (input.environmentId && existing?.kind !== "ssh") throw new Error("设备不存在，请刷新设置后重试");
  return sshConnections.test(profile, parseSshCredentials(input.credentials), previousFingerprint(existing?.kind === "ssh" ? existing : undefined, profile));
});

ipcMain.handle("vibemate:save-ssh-environment", async (event, value: unknown) => {
  const input = settingsInput(event, value);
  const profile = parseSshDeviceInput(input.profile);
  if (input.environmentId !== undefined && typeof input.environmentId !== "string") throw new TypeError("设备编号不正确");
  if (input.verificationId !== undefined && typeof input.verificationId !== "string") throw new TypeError("连接检查编号不正确");
  const existing = configuration.environments.find(item => input.environmentId
    ? item.environmentId === input.environmentId
    : item.kind === "ssh" && item.sshConnection?.host.toLowerCase() === profile.host.toLowerCase()
      && item.sshConnection.port === profile.port && item.sshConnection.username === profile.username);
  const view = receiverManager.getSnapshot().environments.find(item => item.environmentId === existing?.environmentId);
  if (view?.status === "connected" || view?.status === "starting") throw new Error("请先停止该设备监控，再修改连接信息");
  const verified = input.verificationId ? sshConnections.takeVerification(input.verificationId, profile) : undefined;
  const next = configureSshEnvironment(configuration, profile, verified?.connection, input.environmentId as string | undefined);
  await environmentStore.save(next.configuration);
  if (existing) await receiverManager.stop(existing.environmentId);
  if (existing?.kind === "ssh" && existing.sshConnection
    && connectionKey(existing.sshConnection) !== connectionKey(next.environment.sshConnection!)) sshConnections.forget(existing.sshConnection);
  if (verified) sshConnections.remember(next.environment.sshConnection!, verified.credentials);
  configuration = next.configuration;
  receiverManager.setConfiguration(configuration);
  return { snapshot: getSnapshot(), environmentId: next.environment.environmentId };
});

ipcMain.handle("vibemate:remove-ssh-environment", async (event, environmentId: unknown) => {
  settingsInput(event, {});
  if (typeof environmentId !== "string") throw new TypeError("设备编号不正确");
  const environment = configuration.environments.find(item => item.environmentId === environmentId);
  if (environment?.kind !== "ssh") throw new Error("设备不存在，请刷新设置后重试");
  const answer = await dialog.showMessageBox(controlWindow!, {
    type: "question", title: "移除设备配置", message: `从 VibeMate 移除“${environment.name}”的连接配置？`,
    detail: "将停止此设备监控并移除本次保存的登录凭证。设备上的接收端文件和 Agent Hook 会保留，你可以稍后重新添加设备。",
    buttons: ["取消", "移除配置"], defaultId: 0, cancelId: 0,
  });
  if (answer.response !== 1) return getSnapshot();
  await receiverManager.stop(environmentId);
  const next = structuredClone(configuration);
  next.environments = next.environments.filter(item => item.environmentId !== environmentId);
  if (!next.environments.some(item => item.deviceId === environment.deviceId)) next.devices = next.devices.filter(item => item.deviceId !== environment.deviceId);
  await environmentStore.save(next);
  if (environment.sshConnection) {
    sshConnections.forget(environment.sshConnection);
    if (!next.environments.some(item => item.kind === "ssh"
      && item.sshConnection?.host.toLowerCase() === environment.sshConnection!.host.toLowerCase()
      && item.sshConnection.port === environment.sshConnection!.port)) sshConnections.forgetHost(environment.sshConnection);
  }
  configuration = next; receiverManager.setConfiguration(configuration);
  return getSnapshot();
});

ipcMain.handle("vibemate:set-system-notifications", async (event, enabled: unknown) => {
  settingsInput(event, {});
  if (typeof enabled !== "boolean") throw new TypeError("invalid notification setting");
  configuration.preferences.systemNotifications = enabled;
  await environmentStore.save(configuration);
  receiverManager.setConfiguration(configuration);
  return getSnapshot();
});

ipcMain.handle("vibemate:set-pet-enabled", async (event, enabled: unknown) => {
  settingsInput(event, {});
  if (typeof enabled !== "boolean") throw new TypeError("invalid pet setting");
  await setPetEnabled(enabled);
  return getSnapshot();
});

ipcMain.handle("vibemate:set-focus", async (_event, focus: unknown) => {
  if (!focus || typeof focus !== "object" || !("kind" in focus)
    || !["all", "device", "environment", "project", "session"].includes(String(focus.kind))
    || (focus.kind !== "all" && (!("id" in focus) || typeof focus.id !== "string"))) {
    throw new TypeError("invalid pet focus");
  }
  const focusValue = focus as { kind: "all" | "device" | "environment" | "project" | "session"; id?: string };
  configuration.preferences.focus = focusValue.kind === "all"
    ? { kind: "all" }
    : { kind: focusValue.kind, id: focusValue.id as string };
  await environmentStore.save(configuration);
  receiverManager.setConfiguration(configuration);
  return getSnapshot();
});

async function startDesktop(): Promise<void> {
  // Windows only shows toasts for apps with an AppUserModelID matching the installer's appId.
  if (process.platform === "win32") app.setAppUserModelId("com.dfrobot.vibemate");
  await app.whenReady();
  try {
    environmentStore = new EnvironmentStore(join(app.getPath("userData"), "environments.json"), hostname());
    configuration = await environmentStore.load();
    const payloadRoot = app.isPackaged
      ? join(process.resourcesPath, "linux-payload")
      : fileURLToPath(new URL("../../../build/linux-payload", import.meta.url));
    receiverManager = new ReceiverConnectionManager(configuration, new ManagedEnvironmentLauncher(payloadRoot, new ManualSshLauncher(payloadRoot, sshConnections)), (error) => {
      console.error("Environment Receiver error:", error.message);
    });
    receiverManager.subscribe(scheduleSnapshot);
    const local = configuration.environments.find((environment) => environment.kind === "windows" && environment.enabled);
    if (local) {
      await installWindowsHooks();
      await receiverManager.start(local.environmentId);
    }
    if (process.platform === "win32") {
      const runningWsl = new Set((await discoverWsl()).filter((item) => item.running).map((item) => item.name.toLowerCase()));
      const enabledRunning = configuration.environments.filter((environment) => (
        environment.kind === "wsl" && environment.enabled && runningWsl.has(environment.distribution.toLowerCase())
      ));
      await Promise.allSettled(enabledRunning.map((environment) => receiverManager.start(environment.environmentId)));
    }
    controlWindow = createControlWindow();
    if (configuration.preferences.petEnabled) await pet.create(configuration.preferences.showPet);
    await reminder.create(configuration.preferences.showPreview);
    createTray();
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown startup error";
    console.error(`VibeMate desktop failed to start: ${message}`);
    app.exit(1);
  }
}

void startDesktop();

app.on("activate", () => {
  showControlWindow();
});

let stopping = false;
app.on("before-quit", (event) => {
  if (stopping) {
    return;
  }
  event.preventDefault();
  stopping = true;
  quitting = true;
  void (async () => {
    const pendingCount = getSnapshot().pendingPermissions.length;
    if (pendingCount > 0) {
      const answer = await dialog.showMessageBox({
        type: "warning",
        title: "仍有待审批操作",
        message: `还有 ${pendingCount} 个权限请求等待处理，确定退出 VibeMate 吗？`,
        detail: "退出后这些远程审批将不再由桌面端处理。",
        buttons: ["继续使用", "退出"],
        defaultId: 0,
        cancelId: 0,
      });
      if (answer.response === 0) {
        stopping = false;
        quitting = false;
        showControlWindow();
        return;
      }
    }
    try {
      await pet.save();
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown position save error";
      console.error(`Could not save pet position during shutdown: ${message}`);
    }
    try {
      await receiverManager?.stopAll(3_000);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown shutdown error";
      console.error(`VibeMate desktop shutdown failed: ${message}`);
    }
    sshConnections.clear();
    app.quit();
  })();
});
