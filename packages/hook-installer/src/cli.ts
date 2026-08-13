#!/usr/bin/env node

import {
  installCodexHooks,
  installCopilotHooks,
  uninstallCodexHooks,
  uninstallCopilotHooks,
  type InstallResult,
  type UninstallResult,
} from "./index.js";

function printResult(agent: string, result: InstallResult): void {
  process.stdout.write(
    `${agent}: ${result.changed ? "updated" : "unchanged"} ${result.configPath}`
    + ` (${result.added} added, ${result.updated} updated, ${result.unchanged} unchanged)\n`,
  );
  for (const warning of result.warnings) {
    process.stderr.write(`${agent}: warning: ${warning}\n`);
  }
}

function printUninstallResult(agent: string, result: UninstallResult): void {
  process.stdout.write(
    `${agent}: ${result.changed ? "updated" : "unchanged"} ${result.configPath}`
    + ` (${result.removed} removed)\n`,
  );
}

async function main(): Promise<void> {
  const action = process.argv[2] === "install" || process.argv[2] === "uninstall"
    ? process.argv[2]
    : "install";
  const target = action === "install"
    ? process.argv[2] === "install" ? process.argv[3] ?? "all" : process.argv[2] ?? "all"
    : process.argv[3] ?? "all";
  if (target !== "all" && target !== "codex" && target !== "copilot") {
    throw new Error("usage: vibemate-hooks [install|uninstall] [all|codex|copilot]");
  }
  if (action === "install") {
    if (target === "all" || target === "codex") {
      printResult("codex", await installCodexHooks());
    }
    if (target === "all" || target === "copilot") {
      printResult("copilot", await installCopilotHooks());
    }
  } else {
    if (target === "all" || target === "codex") {
      printUninstallResult("codex", await uninstallCodexHooks());
    }
    if (target === "all" || target === "copilot") {
      printUninstallResult("copilot", await uninstallCopilotHooks());
    }
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown installer error";
  process.stderr.write(`VibeMate hook installer: ${message}\n`);
  process.exitCode = 1;
});
