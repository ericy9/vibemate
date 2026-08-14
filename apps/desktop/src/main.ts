import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  Tray,
  type Rectangle,
} from "electron";
import { parsePermissionDecision } from "@vibemate/protocol";
import { VibeMateReceiver } from "@vibemate/receiver";

const sourceDirectory = fileURLToPath(new URL(".", import.meta.url));
const rendererDirectory = join(sourceDirectory, "../src/renderer");
const preloadPath = join(sourceDirectory, "../src/preload.cjs");
const PET_WIDTH = 220;
const PET_HEIGHT = 230;
const PET_MARGIN = 20;

const receiver = new VibeMateReceiver({
  onError: (error) => {
    console.error("Receiver error:", error.message);
  },
});

let controlWindow: BrowserWindow | undefined;
let petWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let snapshotScheduled = false;
let positionSaveTimer: NodeJS.Timeout | undefined;
let quitting = false;

function getSnapshot() {
  return {
    sessions: receiver.sessions.list(),
    pendingPermissions: receiver.permissions.listPending(),
  };
}

function publishSnapshot(): void {
  const snapshot = getSnapshot();
  for (const window of [controlWindow, petWindow]) {
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
    height: 680,
    minWidth: 380,
    minHeight: 560,
    title: "VibeMate",
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

function petPositionPath(): string {
  return join(app.getPath("userData"), "pet-position.json");
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

function isVisiblePosition(x: number, y: number): boolean {
  return screen.getAllDisplays().some(({ workArea }) => (
    x + PET_WIDTH > workArea.x
    && x < workArea.x + workArea.width
    && y + PET_HEIGHT > workArea.y
    && y < workArea.y + workArea.height
  ));
}

async function loadPetBounds(): Promise<Rectangle> {
  try {
    const value: unknown = JSON.parse(await readFile(petPositionPath(), "utf8"));
    if (
      value
      && typeof value === "object"
      && "x" in value
      && "y" in value
      && typeof value.x === "number"
      && Number.isInteger(value.x)
      && typeof value.y === "number"
      && Number.isInteger(value.y)
      && isVisiblePosition(value.x, value.y)
    ) {
      return { x: value.x, y: value.y, width: PET_WIDTH, height: PET_HEIGHT };
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      const message = error instanceof Error ? error.message : "unknown position read error";
      console.error(`Could not restore pet position: ${message}`);
    }
  }
  return defaultPetBounds();
}

async function savePetPosition(): Promise<void> {
  if (!petWindow || petWindow.isDestroyed()) {
    return;
  }
  const { x, y } = petWindow.getBounds();
  const path = petPositionPath();
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await mkdir(app.getPath("userData"), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify({ x, y })}\n`, "utf8");
  await rename(temporaryPath, path);
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
    frame: false,
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

function showControlWindow(): void {
  if (!controlWindow) {
    controlWindow = createControlWindow();
  }
  controlWindow.show();
  controlWindow.focus();
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
      label: petWindow?.isVisible() ? "隐藏桌宠" : "显示桌宠",
      click: togglePetWindow,
    },
    {
      label: "打开控制面板",
      click: showControlWindow,
    },
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
ipcMain.on("vibemate:show-control", showControlWindow);
ipcMain.handle(
  "vibemate:submit-decision",
  (_event, identity: unknown, decision: unknown) => {
    if (
      !identity
      || typeof identity !== "object"
      || !("requestId" in identity)
      || !("sourceProfile" in identity)
      || !("agent" in identity)
      || !("sessionId" in identity)
      || typeof identity.requestId !== "string"
      || typeof identity.sourceProfile !== "string"
      || (identity.agent !== "codex" && identity.agent !== "copilot")
      || typeof identity.sessionId !== "string"
      || (decision !== "allow" && decision !== "deny")
    ) {
      throw new TypeError("invalid permission decision");
    }
    const request = receiver.permissions.listPending()
      .find((pending) => (
        pending.requestId === identity.requestId
        && pending.sourceProfile === identity.sourceProfile
        && pending.agent === identity.agent
        && pending.sessionId === identity.sessionId
      ));
    if (!request) {
      return "not_found";
    }
    return receiver.permissions.submitDecision(parsePermissionDecision({
      protocolVersion: 1,
      requestId: request.requestId,
      sourceProfile: request.sourceProfile,
      agent: request.agent,
      sessionId: request.sessionId,
      decision,
      decidedAt: new Date().toISOString(),
    }));
  },
);

receiver.sessions.subscribe(scheduleSnapshot);
receiver.permissions.subscribe(scheduleSnapshot);

await app.whenReady();
try {
  await receiver.start();
  controlWindow = createControlWindow();
  petWindow = await createPetWindow();
  createTray();
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown startup error";
  console.error(`VibeMate desktop failed to start: ${message}`);
  app.exit(1);
}

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
    try {
      await savePetPosition();
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown position save error";
      console.error(`Could not save pet position during shutdown: ${message}`);
    }
    try {
      await receiver.stop();
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown shutdown error";
      console.error(`VibeMate desktop shutdown failed: ${message}`);
    }
    app.quit();
  })();
});
