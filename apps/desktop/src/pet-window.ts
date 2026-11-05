import { screen, type BrowserWindow, type Rectangle } from "electron";
import { createFloatingWindow } from "./floating-window.js";
import type { WindowPositionStore } from "./window-position.js";

const PET_WIDTH = 320;
const PET_HEIGHT = 340;
const PET_MARGIN = 20;

function defaultPetBounds(): Rectangle {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: workArea.x + workArea.width - PET_WIDTH - PET_MARGIN,
    y: workArea.y + workArea.height - PET_HEIGHT - PET_MARGIN,
    width: PET_WIDTH,
    height: PET_HEIGHT,
  };
}

/** The hidden easter-egg pet. Only created once `preferences.petEnabled` is set. */
export class PetWindow {
  window: BrowserWindow | undefined;
  private saveTimer: NodeJS.Timeout | undefined;

  constructor(private readonly positions: WindowPositionStore, private readonly options: { preload: string; page: string; onLoad: () => void }) {}

  async create(show: boolean): Promise<BrowserWindow> {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const stored = await this.positions.load("pet", PET_WIDTH, PET_HEIGHT);
    const window = createFloatingWindow({
      ...this.options,
      ...(stored ? { x: stored.x, y: stored.y, width: PET_WIDTH, height: PET_HEIGHT } : defaultPetBounds()),
      show,
      focusable: false,
      title: "VibeMate Pet",
    });
    window.on("moved", () => this.scheduleSave());
    window.on("closed", () => { if (this.window === window) this.window = undefined; });
    this.window = window;
    return window;
  }

  async destroy(): Promise<void> {
    await this.save().catch(() => undefined);
    this.window?.destroy();
    this.window = undefined;
  }

  async save(): Promise<void> {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = undefined; }
    if (!this.window || this.window.isDestroyed()) return;
    const { x, y } = this.window.getBounds();
    await this.positions.save("pet", { x, y });
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.save().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "unknown position save error";
        console.error(`Could not save pet position: ${message}`);
      });
    }, 250);
  }
}
