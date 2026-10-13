import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DesktopConfiguration, EnvironmentConfig } from "./environment-types.js";

export function createDefaultConfiguration(computerName: string): DesktopConfiguration {
  const deviceId = randomUUID();
  return {
    version: 1,
    devices: [{ deviceId, name: computerName, kind: "local" }],
    environments: [{
      environmentId: randomUUID(), deviceId, name: "Windows 本机", kind: "windows", enabled: false, codexApprovalsEnabled: false,
    }],
    preferences: { showPet: true, showPreview: true, focus: { kind: "all" } },
    onboardingCompleted: false,
  };
}

function isConfiguration(value: unknown): value is DesktopConfiguration {
  return Boolean(value && typeof value === "object" && "version" in value && value.version === 1
    && "devices" in value && Array.isArray(value.devices)
    && "environments" in value && Array.isArray(value.environments)
    && "preferences" in value && value.preferences && typeof value.preferences === "object");
}

export class EnvironmentStore {
  constructor(private readonly path: string, private readonly computerName: string) {}

  async load(): Promise<DesktopConfiguration> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!isConfiguration(value)) throw new Error("unsupported VibeMate settings format");
      for (const environment of value.environments) {
        environment.codexApprovalsEnabled = environment.codexApprovalsEnabled === true;
      }
      value.preferences.showPet = value.preferences.showPet !== false;
      value.preferences.showPreview = value.preferences.showPreview !== false;
      return value;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      return createDefaultConfiguration(this.computerName);
    }
  }

  async save(configuration: DesktopConfiguration): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(configuration, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.path);
  }

  static mergeDiscovered(existing: EnvironmentConfig[], discovered: EnvironmentConfig[]): EnvironmentConfig[] {
    const keys = new Set(existing.map(EnvironmentStore.discoveryKey));
    return [...existing, ...discovered.filter((item) => !keys.has(EnvironmentStore.discoveryKey(item)))];
  }

  private static discoveryKey(environment: EnvironmentConfig): string {
    if (environment.kind === "wsl") return `wsl:${environment.distribution.toLowerCase()}`;
    if (environment.kind === "ssh") {
      const connection = environment.sshConnection;
      return connection
        ? `ssh:manual:${connection.host.toLowerCase()}:${connection.port}:${connection.username}`
        : `ssh:${environment.sshHost.toLowerCase()}`;
    }
    return "windows";
  }
}
