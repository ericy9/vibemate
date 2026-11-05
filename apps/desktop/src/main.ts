import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
  screen,
  Tray,
  type Rectangle,
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

const sourceDirectory = fileURLToPath(new URL(".", import.meta.url));
const rendererDirectory = join(sourceDirectory, "../src/renderer");
const preloadPath = join(sourceDirectory, "../src/preload.cjs");
const PET_WIDTH = 320;
const PET_HEIGHT = 340;
const PET_MARGIN = 20;
const PREVIEW_MARGIN = 12;
const PREVIEW_PEEK = 8;
const DOCK_THRESHOLD = 16;
const PREVIEW_DEFAULT_SIZE = { width: 220, height: 52 };

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
let petWindow: BrowserWindow | undefined;
let previewWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let snapshotScheduled = false;
let positionSaveTimer: NodeJS.Timeout | undefined;
let quitting = false;

function getSnapshot() {
  return receiverManager?.getSnapshot() ?? {
    devices: [], environments: [], sessions: [], pendingPermissions: [],
    preferences: { petEnabled: false, showPet: true, showPreview: true, focus: { kind: "all" as const } },
    onboardingCompleted: false,
  };
}

function publishSnapshot(): void {
  const snapshot = getSnapshot();
  for (const window of [controlWindow, petWindow, previewWindow]) {
    if (window && !window.isDestroyed()) {
      window.webContents.send("vibemate:snapshot", snapshot);
    }
  }
}

function scheduleSnapshot(): void {
  if (snapshotScheduled) {
    return;
  }
  snapshotScheduled = true;
  queueMicrotask(() => {
    snapshotScheduled = false;
    publishSnapshot();
  });
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

type Dock = "left" | "right" | undefined;
interface StoredPosition { x: number; y: number; dock?: Dock }

function positionPath(name: string): string {
  return join(app.getPath("userData"), `${name}-position.json`);
}

function defaultPetBounds(): Rectangle {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: workArea.x + workArea.width - PET_WIDTH - PET_MARGIN,
    y: workArea.y + workArea.height - PET_HEIGHT - PET_MARGIN,
    width: PET_WIDTH,
    height: PET_HEIGHT,
  };
}

function isVisiblePosition(x: number, y: number, width: number, height: number): boolean {
  return screen.getAllDisplays().some(({ workArea }) => (
    x + width > workArea.x
    && x < workArea.x + workArea.width
    && y + height > workArea.y
    && y < workArea.y + workArea.height
  ));
}

async function loadPosition(name: string, width: number, height: number): Promise<StoredPosition | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(positionPath(name), "utf8"));
    if (
      value
      && typeof value === "object"
      && "x" in value
      && "y" in value
      && typeof value.x === "number"
      && Number.isInteger(value.x)
      && typeof value.y === "number"
      && Number.isInteger(value.y)
      && isVisiblePosition(value.x, value.y, width, height)
    ) {
      const dock = "dock" in value && (value.dock === "left" || value.dock === "right") ? value.dock : undefined;
      return { x: value.x, y: value.y, dock };
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      const message = error instanceof Error ? error.message : "unknown position read error";
      console.error(`Could not restore ${name} position: ${message}`);
    }
  }
  return undefined;
}

async function savePosition(name: string, position: StoredPosition): Promise<void> {
  const path = positionPath(name);
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await mkdir(app.getPath("userData"), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(position)}\n`, "utf8");
  await rename(temporaryPath, path);
}

async function loadPetBounds(): Promise<Rectangle> {
  const stored = await loadPosition("pet", PET_WIDTH, PET_HEIGHT);
  return stored ? { x: stored.x, y: stored.y, width: PET_WIDTH, height: PET_HEIGHT } : defaultPetBounds();
}

async function savePetPosition(): Promise<void> {
  if (!petWindow || petWindow.isDestroyed()) {
    return;
  }
  const { x, y } = petWindow.getBounds();
  await savePosition("pet", { x, y });
}

function schedulePositionSave(): void {
  if (positionSaveTimer) {
    clearTimeout(positionSaveTimer);
  }
  positionSaveTimer = setTimeout(() => {
    positionSaveTimer = undefined;
    void savePetPosition().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "unknown position save error";
      console.error(`Could not save pet position: ${message}`);
    });
  }, 250);
}

async function createPetWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    ...(await loadPetBounds()),
    transparent: true,
    show: configuration?.preferences.showPet ?? true,
    backgroundColor: "#00000000",
    type: "toolbar",
    frame: false,
    focusable: false,
    resizable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    title: "VibeMate Pet",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.setHasShadow(false);
  window.setAlwaysOnTop(true, "floating");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  void window.loadFile(join(rendererDirectory, "pet.html"));
  window.webContents.once("did-finish-load", publishSnapshot);
  window.on("moved", schedulePositionSave);
  window.on("closed", () => {
    if (petWindow === window) {
      petWindow = undefined;
    }
  });
  return window;
}

interface PreviewState { mode: "dot" | "capsule" | "expanded"; width: number; height: number; hovered: boolean }

let previewState: PreviewState = { mode: "capsule", ...PREVIEW_DEFAULT_SIZE, hovered: false };
let previewPosition: StoredPosition = { x: 0, y: 0 };
let previewDragOrigin: { x: number; y: number } | undefined;
let previewSaveTimer: NodeJS.Timeout | undefined;

function defaultPreviewPosition(): StoredPosition {
  const { workArea } = screen.getPrimaryDisplay();
  const pet = petWindow?.getBounds() ?? defaultPetBounds();
  return {
    x: pet.x - PREVIEW_DEFAULT_SIZE.width - PREVIEW_MARGIN,
    y: workArea.y + workArea.height - PREVIEW_DEFAULT_SIZE.height - PREVIEW_MARGIN,
  };
}

// Computes where the window should sit for the current mode, dock and hover state.
function previewBounds(): Rectangle {
  const { width, height, mode, hovered } = previewState;
  const area = screen.getDisplayMatching({ ...previewPosition, width, height }).workArea;
  const revealed = hovered || mode === "expanded";
  let x = previewPosition.x;
  if (previewPosition.dock === "left") {
    x = revealed ? area.x : area.x - width + PREVIEW_PEEK;
  } else if (previewPosition.dock === "right") {
    x = revealed ? area.x + area.width - width : area.x + area.width - PREVIEW_PEEK;
  } else {
    x = Math.max(area.x, Math.min(x, area.x + area.width - width));
  }
  const y = Math.max(area.y, Math.min(previewPosition.y, area.y + area.height - height));
  return { x, y, width, height };
}

function applyPreviewBounds(): void {
  if (!previewWindow || previewWindow.isDestroyed() || previewDragOrigin) return;
  previewWindow.setBounds(previewBounds());
}

function schedulePreviewSave(): void {
  if (previewSaveTimer) clearTimeout(previewSaveTimer);
  previewSaveTimer = setTimeout(() => {
    previewSaveTimer = undefined;
    void savePosition("preview", previewPosition).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "unknown position save error";
      console.error(`Could not save preview position: ${message}`);
    });
  }, 250);
}

async function createPreviewWindow(): Promise<BrowserWindow> {
  previewPosition = (await loadPosition("preview", PREVIEW_DEFAULT_SIZE.width, PREVIEW_DEFAULT_SIZE.height))
    ?? defaultPreviewPosition();
  const window = new BrowserWindow({
    ...previewBounds(),
    transparent: true,
    show: configuration?.preferences.showPreview ?? true,
    backgroundColor: "#00000000",
    type: "toolbar",
    frame: false,
    focusable: true,
    resizable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    title: "VibeMate 悬浮监控",
    webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.setHasShadow(false);
  window.setAlwaysOnTop(true, "floating");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  void window.loadFile(join(rendererDirectory, "preview.html"));
  window.webContents.once("did-finish-load", publishSnapshot);
  window.on("closed", () => { if (previewWindow === window) previewWindow = undefined; });
  return window;
}

function handlePreviewDrag(phase: "start" | "move" | "end", dx: number, dy: number): void {
  if (!previewWindow || previewWindow.isDestroyed()) return;
  if (phase === "start") {
    const { x, y } = previewWindow.getBounds();
    previewDragOrigin = { x, y };
    return;
  }
  if (!previewDragOrigin) return;
  if (phase === "move") {
    previewWindow.setPosition(Math.round(previewDragOrigin.x + dx), Math.round(previewDragOrigin.y + dy));
    return;
  }
  previewDragOrigin = undefined;
  const bounds = previewWindow.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  let dock: Dock;
  if (bounds.x <= area.x + DOCK_THRESHOLD) dock = "left";
  else if (bounds.x + bounds.width >= area.x + area.width - DOCK_THRESHOLD) dock = "right";
  previewPosition = { x: bounds.x, y: bounds.y, dock };
  applyPreviewBounds();
  schedulePreviewSave();
}

function togglePreviewWindow(): void {
  if (!previewWindow) return;
  if (previewWindow.isVisible()) previewWindow.hide();
  else previewWindow.showInactive();
  configuration.preferences.showPreview = previewWindow.isVisible();
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
    petWindow ??= await createPetWindow();
    petWindow.showInactive();
  } else if (petWindow) {
    await savePetPosition().catch(() => undefined);
    petWindow.destroy();
    petWindow = undefined;
  }
  await environmentStore.save(configuration);
  receiverManager.setConfiguration(configuration);
  updateTrayMenu();
}

function togglePetWindow(): void {
  if (!petWindow) {
    return;
  }
  if (petWindow.isVisible()) {
    petWindow.hide();
  } else {
    petWindow.showInactive();
  }
  configuration.preferences.showPet = petWindow.isVisible();
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
      label: previewWindow?.isVisible() ? "隐藏悬浮提醒窗" : "显示悬浮提醒窗",
      click: togglePreviewWindow,
    },
    {
      label: "设置…",
      click: showControlWindow,
    },
    ...(petWindow ? [{
      label: petWindow.isVisible() ? "隐藏桌宠" : "显示桌宠",
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
  if (event.sender !== previewWindow?.webContents) return;
  if (previewWindow.isVisible()) togglePreviewWindow();
});
ipcMain.on("vibemate:preview-state", (event, state: unknown) => {
  if (event.sender !== previewWindow?.webContents || !state || typeof state !== "object") return;
  const { mode, width, height, hovered } = state as Record<string, unknown>;
  if ((mode !== "dot" && mode !== "capsule" && mode !== "expanded")
    || typeof width !== "number" || typeof height !== "number" || typeof hovered !== "boolean"
    || !Number.isFinite(width) || !Number.isFinite(height)) return;
  previewState = {
    mode,
    width: Math.max(24, Math.min(600, Math.ceil(width))),
    height: Math.max(24, Math.min(800, Math.ceil(height))),
    hovered,
  };
  applyPreviewBounds();
});
ipcMain.on("vibemate:preview-drag", (event, phase: unknown, dx: unknown, dy: unknown) => {
  if (event.sender !== previewWindow?.webContents) return;
  if ((phase !== "start" && phase !== "move" && phase !== "end")
    || typeof dx !== "number" || typeof dy !== "number" || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
  handlePreviewDrag(phase, dx, dy);
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
    if (configuration.preferences.petEnabled) petWindow = await createPetWindow();
    previewWindow = await createPreviewWindow();
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
  if (positionSaveTimer) {
    clearTimeout(positionSaveTimer);
    positionSaveTimer = undefined;
  }
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
      await savePetPosition();
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
