import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain } from "electron";
import { parsePermissionDecision } from "@vibemate/protocol";
import { VibeMateReceiver } from "@vibemate/receiver";

const sourceDirectory = fileURLToPath(new URL(".", import.meta.url));
const rendererDirectory = join(sourceDirectory, "../src/renderer");
const preloadPath = join(sourceDirectory, "../src/preload.cjs");

const receiver = new VibeMateReceiver({
  onError: (error) => {
    console.error("Receiver error:", error.message);
  },
});

let mainWindow: BrowserWindow | undefined;
let snapshotScheduled = false;

function getSnapshot() {
  return {
    sessions: receiver.sessions.list(),
    pendingPermissions: receiver.permissions.listPending(),
  };
}

function publishSnapshot(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send("vibemate:snapshot", getSnapshot());
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

function createWindow(): BrowserWindow {
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
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = undefined;
    }
  });
  return window;
}

ipcMain.handle("vibemate:get-snapshot", () => getSnapshot());
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
  mainWindow = createWindow();
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown startup error";
  console.error(`VibeMate desktop failed to start: ${message}`);
  app.exit(1);
}

app.on("activate", () => {
  if (!mainWindow) {
    mainWindow = createWindow();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

let stopping = false;
app.on("before-quit", (event) => {
  if (stopping) {
    return;
  }
  event.preventDefault();
  stopping = true;
  void receiver.stop()
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "unknown shutdown error";
      console.error(`VibeMate desktop shutdown failed: ${message}`);
    })
    .finally(() => app.quit());
});
