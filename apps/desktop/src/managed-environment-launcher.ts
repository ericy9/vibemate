import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import type { EnvironmentConfig } from "./environment-types.js";
import type { EnvironmentLauncher, ReceiverEndpoint } from "./receiver-connection-manager.js";
import { EmbeddedReceiverLauncher } from "./receiver-connection-manager.js";

interface ReadyMessage {
  type: "ready";
  protocolVersion: 1;
  host: string;
  port: number;
  authToken: string;
}

const REMOTE_NODE = "$HOME/.vibemate/runtime/node";
const REMOTE_RECEIVER = "$HOME/.vibemate/app/receiver/dist/cli.js";
const REMOTE_INSTALLER = "$HOME/.vibemate/app/hook-installer/dist/cli.js";

function waitForReady(child: ChildProcessWithoutNullStreams, label: string): Promise<ReadyMessage> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => fail(new Error(`${label} Receiver 启动超时`)), 15_000);
    const fail = (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4_096); });
    child.once("error", fail);
    child.once("exit", (code) => fail(new Error(`${label} Receiver 已退出 (${code ?? "unknown"})${stderr ? `: ${stderr.trim()}` : ""}`)));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      for (;;) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) break;
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        try {
          const value: unknown = JSON.parse(line);
          if (value && typeof value === "object" && "type" in value && value.type === "ready"
            && "protocolVersion" in value && value.protocolVersion === 1
            && "host" in value && typeof value.host === "string"
            && "port" in value && typeof value.port === "number"
            && "authToken" in value && typeof value.authToken === "string") {
            clearTimeout(timeout);
            resolve(value as ReadyMessage);
            return;
          }
        } catch {
          // The Receiver can emit a human-readable startup line before the control message.
        }
      }
    });
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  child.stdin.write('{"type":"shutdown"}\n');
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(() => {
      child.kill();
      resolve();
    }, 2_500)),
  ]);
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法分配本地 SSH 端口");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

export class ManagedEnvironmentLauncher implements EnvironmentLauncher {
  private readonly embedded = new EmbeddedReceiverLauncher();

  constructor(private readonly payloadRoot?: string) {}

  async start(environment: EnvironmentConfig): Promise<ReceiverEndpoint> {
    if (environment.kind === "windows") return this.embedded.start(environment);
    if (environment.kind === "wsl") return this.startWsl(environment.distribution);
    return this.startSsh(environment.sshHost);
  }

  private async startWsl(distribution: string): Promise<ReceiverEndpoint> {
    if (process.platform !== "win32") throw new Error("WSL 环境只能从 Windows 桌面版启动");
    await this.provisionWsl(distribution);
    const child = spawn("wsl.exe", ["--distribution", distribution, "--exec", "sh", "-lc", `exec env VIBEMATE_MANAGED=1 ${REMOTE_NODE} ${REMOTE_RECEIVER}`], {
      windowsHide: true, stdio: "pipe",
    });
    try {
      const ready = await waitForReady(child, `WSL ${distribution}`);
      return {
        url: `ws://127.0.0.1:${ready.port}/v1/stream`, authToken: ready.authToken,
        stop: () => stopChild(child),
      };
    } catch (error) {
      child.kill();
      throw error;
    }
  }

  private async startSsh(host: string): Promise<ReceiverEndpoint> {
    await this.provisionSsh(host);
    const remoteCommand = `VIBEMATE_MANAGED=1 ${REMOTE_NODE} ${REMOTE_RECEIVER}`;
    const control = spawn("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, remoteCommand], {
      windowsHide: true, stdio: "pipe",
    });
    let tunnel: ChildProcessWithoutNullStreams | undefined;
    try {
      const ready = await waitForReady(control, `SSH ${host}`);
      const localPort = await availablePort();
      tunnel = spawn("ssh", ["-N", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ExitOnForwardFailure=yes", "-L", `${localPort}:127.0.0.1:${ready.port}`, host], {
        windowsHide: true, stdio: "pipe",
      });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(resolve, 350);
        tunnel?.once("error", (error) => { clearTimeout(timeout); reject(error); });
        tunnel?.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`SSH 隧道启动失败 (${code ?? "unknown"})`)); });
      });
      const activeTunnel = tunnel;
      return {
        url: `ws://127.0.0.1:${localPort}/v1/stream`, authToken: ready.authToken,
        stop: async () => {
          activeTunnel.kill();
          await stopChild(control);
        },
      };
    } catch (error) {
      tunnel?.kill();
      control.kill();
      throw error;
    }
  }

  private async provisionWsl(distribution: string): Promise<void> {
    const architecture = (await this.capture("wsl.exe", ["--distribution", distribution, "--exec", "uname", "-m"])).trim();
    const payload = await this.payloadForArchitecture(architecture);
    await this.copyPayload(payload, "wsl.exe", ["--distribution", distribution, "--exec", "sh", "-lc", "mkdir -p \"$HOME/.vibemate\" && tar -xf - -C \"$HOME/.vibemate\""]);
    await this.capture("wsl.exe", ["--distribution", distribution, "--exec", "sh", "-lc", `${REMOTE_NODE} ${REMOTE_INSTALLER} install`]);
  }

  private async provisionSsh(host: string): Promise<void> {
    const common = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host];
    await this.capture("ssh", ["-G", host]);
    const architecture = (await this.capture("ssh", [...common, "uname -m"])).trim();
    const payload = await this.payloadForArchitecture(architecture);
    await this.copyPayload(payload, "ssh", [...common, "mkdir -p \"$HOME/.vibemate\" && tar -xf - -C \"$HOME/.vibemate\""]);
    await this.capture("ssh", [...common, `${REMOTE_NODE} ${REMOTE_INSTALLER} install`]);
  }

  private async payloadForArchitecture(value: string): Promise<string> {
    const architecture = /^(aarch64|arm64)$/i.test(value) ? "arm64" : /^(x86_64|amd64)$/i.test(value) ? "x64" : undefined;
    if (!architecture) throw new Error(`不支持的 Linux 架构: ${value}`);
    if (!this.payloadRoot) throw new Error("当前 VibeMate 安装包不包含 Linux 运行时");
    const payload = join(this.payloadRoot, architecture);
    try { await access(join(payload, "runtime", "node")); }
    catch { throw new Error(`缺少 Linux ${architecture} 运行时，请重新安装完整版本 VibeMate`); }
    return payload;
  }

  private capture(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `${command} 执行失败 (${code ?? "unknown"})`)));
    });
  }

  private copyPayload(payload: string, command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const archive = spawn("tar", ["-cf", "-", "-C", payload, "."], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const target = spawn(command, args, { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
      let error = "";
      target.stderr.setEncoding("utf8");
      target.stderr.on("data", (chunk: string) => { error += chunk; });
      archive.stdout.pipe(target.stdin);
      archive.once("error", reject);
      target.once("error", reject);
      target.once("exit", (code) => code === 0 ? resolve() : reject(new Error(error.trim() || `环境部署失败 (${code ?? "unknown"})`)));
    });
  }
}
