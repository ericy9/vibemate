import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WslDistribution {
  name: string;
  running: boolean;
  version?: number;
}

export async function discoverWsl(): Promise<WslDistribution[]> {
  if (process.platform !== "win32") return [];
  try {
    const { stdout } = await execFileAsync("wsl.exe", ["--list", "--verbose"], { windowsHide: true });
    return parseWslList(stdout.replaceAll("\0", ""));
  } catch {
    return [];
  }
}

export function parseWslList(output: string): WslDistribution[] {
  const result: WslDistribution[] = [];
  for (const rawLine of output.split(/\r?\n/).slice(1)) {
    const line = rawLine.trim().replace(/^\*\s*/, "");
    if (!line) continue;
    const match = /^(.*?)\s{2,}(Running|Stopped)\s+(\d+)$/i.exec(line);
    if (!match?.[1] || !match[2]) continue;
    result.push({ name: match[1].trim(), running: match[2].toLowerCase() === "running", ...(match[3] ? { version: Number(match[3]) } : {}) });
  }
  return result;
}

export async function discoverSshHosts(configPath = join(homedir(), ".ssh", "config")): Promise<string[]> {
  try {
    const text = await readFile(configPath, "utf8");
    const hosts = new Set<string>();
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*Host\s+(.+)$/i.exec(line);
      if (!match?.[1]) continue;
      for (const host of match[1].trim().split(/\s+/)) {
        if (!host.includes("*") && !host.includes("?") && !host.startsWith("!")) hosts.add(host);
      }
    }
    return [...hosts];
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}
