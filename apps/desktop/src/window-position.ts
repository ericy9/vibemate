import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { screen } from "electron";

export type Dock = "left" | "right" | undefined;
export interface StoredPosition { x: number; y: number; dock?: Dock }

function isVisiblePosition(x: number, y: number, width: number, height: number): boolean {
  return screen.getAllDisplays().some(({ workArea }) => (
    x + width > workArea.x
    && x < workArea.x + workArea.width
    && y + height > workArea.y
    && y < workArea.y + workArea.height
  ));
}

/** Persists small window positions as `<name>-position.json` under the app's user data directory. */
export class WindowPositionStore {
  constructor(private readonly directory: string) {}

  private path(name: string): string {
    return join(this.directory, `${name}-position.json`);
  }

  async load(name: string, width: number, height: number): Promise<StoredPosition | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path(name), "utf8"));
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

  async save(name: string, position: StoredPosition): Promise<void> {
    const path = this.path(name);
    const temporaryPath = `${path}.${process.pid}.tmp`;
    await mkdir(this.directory, { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(position)}\n`, "utf8");
    await rename(temporaryPath, path);
  }
}
