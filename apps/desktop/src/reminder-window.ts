import { screen, type BrowserWindow, type Rectangle } from "electron";
import { createFloatingWindow } from "./floating-window.js";
import type { Dock, StoredPosition, WindowPositionStore } from "./window-position.js";

const MARGIN = 12;
const PEEK = 8;
const DOCK_THRESHOLD = 16;
const DEFAULT_SIZE = { width: 220, height: 52 };

export type ReminderMode = "dot" | "capsule" | "toast" | "expanded";
export interface ReminderState { mode: ReminderMode; width: number; height: number; hovered: boolean }

export function parseReminderState(value: unknown): ReminderState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { mode, width, height, hovered } = value as Record<string, unknown>;
  if ((mode !== "dot" && mode !== "capsule" && mode !== "toast" && mode !== "expanded")
    || typeof width !== "number" || typeof height !== "number" || typeof hovered !== "boolean"
    || !Number.isFinite(width) || !Number.isFinite(height)) return undefined;
  return {
    mode,
    width: Math.max(24, Math.min(600, Math.ceil(width))),
    height: Math.max(24, Math.min(800, Math.ceil(height))),
    hovered,
  };
}

/**
 * The floating reminder window (capsule / toast / expanded list). The renderer reports its size and
 * mode; this side positions it, docks it to screen edges and slides it out while revealed.
 */
export class ReminderWindow {
  window: BrowserWindow | undefined;
  private state: ReminderState = { mode: "capsule", ...DEFAULT_SIZE, hovered: false };
  private position: StoredPosition = { x: 0, y: 0 };
  private dragOrigin: { x: number; y: number } | undefined;
  private saveTimer: NodeJS.Timeout | undefined;

  constructor(private readonly positions: WindowPositionStore, private readonly options: { preload: string; page: string; onLoad: () => void }) {}

  async create(show: boolean): Promise<BrowserWindow> {
    this.position = (await this.positions.load("preview", DEFAULT_SIZE.width, DEFAULT_SIZE.height)) ?? defaultPosition();
    const window = createFloatingWindow({
      ...this.options,
      ...this.bounds(),
      show,
      focusable: true,
      title: "VibeMate 悬浮提醒",
    });
    window.on("closed", () => { if (this.window === window) this.window = undefined; });
    this.window = window;
    return window;
  }

  setState(state: ReminderState): void {
    this.state = state;
    this.apply();
  }

  drag(phase: "start" | "move" | "end", dx: number, dy: number): void {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    if (phase === "start") {
      const { x, y } = window.getBounds();
      this.dragOrigin = { x, y };
      return;
    }
    if (!this.dragOrigin) return;
    if (phase === "move") {
      window.setPosition(Math.round(this.dragOrigin.x + dx), Math.round(this.dragOrigin.y + dy));
      return;
    }
    this.dragOrigin = undefined;
    const bounds = window.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    let dock: Dock;
    if (bounds.x <= area.x + DOCK_THRESHOLD) dock = "left";
    else if (bounds.x + bounds.width >= area.x + area.width - DOCK_THRESHOLD) dock = "right";
    this.position = { x: bounds.x, y: bounds.y, dock };
    this.apply();
    this.scheduleSave();
  }

  // Computes where the window should sit for the current mode, dock and hover state.
  private bounds(): Rectangle {
    const { width, height, mode, hovered } = this.state;
    const area = screen.getDisplayMatching({ ...this.position, width, height }).workArea;
    const revealed = hovered || mode === "expanded" || mode === "toast";
    let x = this.position.x;
    if (this.position.dock === "left") {
      x = revealed ? area.x : area.x - width + PEEK;
    } else if (this.position.dock === "right") {
      x = revealed ? area.x + area.width - width : area.x + area.width - PEEK;
    } else {
      x = Math.max(area.x, Math.min(x, area.x + area.width - width));
    }
    const y = Math.max(area.y, Math.min(this.position.y, area.y + area.height - height));
    return { x, y, width, height };
  }

  private apply(): void {
    if (!this.window || this.window.isDestroyed() || this.dragOrigin) return;
    this.window.setBounds(this.bounds());
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.positions.save("preview", this.position).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "unknown position save error";
        console.error(`Could not save preview position: ${message}`);
      });
    }, 250);
  }
}

function defaultPosition(): StoredPosition {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: workArea.x + workArea.width - DEFAULT_SIZE.width - MARGIN,
    y: workArea.y + workArea.height - DEFAULT_SIZE.height - MARGIN,
  };
}
