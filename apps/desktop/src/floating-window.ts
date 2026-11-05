import { BrowserWindow, type BrowserWindowConstructorOptions } from "electron";

/** Shared options for the frameless, transparent, always-on-top overlays (reminder window and pet). */
export function createFloatingWindow(options: BrowserWindowConstructorOptions & { preload: string; page: string; onLoad: () => void }): BrowserWindow {
  const { preload, page, onLoad, ...windowOptions } = options;
  const window = new BrowserWindow({
    transparent: true,
    backgroundColor: "#00000000",
    type: "toolbar",
    frame: false,
    resizable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    ...windowOptions,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.setHasShadow(false);
  window.setAlwaysOnTop(true, "floating");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  void window.loadFile(page);
  window.webContents.once("did-finish-load", onLoad);
  return window;
}
