import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Client, ClientChannel } from "ssh2";
import type { SshEnvironment } from "./environment-types.js";
import type { ReceiverEndpoint } from "./receiver-connection-manager.js";
import { openCommand, runCommand, SshConnectionService } from "./ssh-connection.js";

interface Ready { port: number; authToken: string }

async function receiverReady(channel: ClientChannel): Promise<Ready> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const finish = (error?: Error, ready?: Ready) => {
      clearTimeout(timer);
      channel.off("data", data); channel.off("close", close); channel.off("error", close);
      if (error) reject(error); else resolve(ready!);
    };
    const close = () => finish(new Error("设备接收服务启动失败，请检查是否有其他 VibeMate 客户端正在监控此设备"));
    const timer = setTimeout(() => finish(new Error("设备接收服务启动超时，请重试")), 15_000);
    const data = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > 64 * 1024) { finish(new Error("设备返回的启动消息不正确")); return; }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const value = JSON.parse(line) as Record<string, unknown>;
          if (value.type === "ready" && value.protocolVersion === 1 && value.host === "127.0.0.1"
            && typeof value.port === "number" && Number.isInteger(value.port) && value.port > 0 && value.port <= 65_535
            && typeof value.authToken === "string" && /^[a-zA-Z0-9_-]{32,128}$/.test(value.authToken)) {
            finish(undefined, { port: value.port, authToken: value.authToken }); return;
          }
        } catch { /* Receiver also emits a human-readable startup line. */ }
      }
    };
    channel.on("data", data); channel.once("close", close); channel.once("error", close);
    channel.stderr.resume();
  });
}

async function uploadPayload(client: Client, payload: string): Promise<void> {
  const channel = await openCommand(client, 'umask 077; mkdir -p "$HOME/.vibemate" && tar -xf - -C "$HOME/.vibemate"');
  const archive = spawn("tar", ["-cf", "-", "-C", payload, "."], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  channel.resume(); channel.stderr.resume(); archive.stderr.resume();
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.all([
      pipeline(archive.stdout, channel),
      new Promise<void>((resolve, reject) => {
        archive.once("error", () => reject(new Error("无法准备设备运行时，请检查本机 tar 工具")));
        archive.once("exit", code => code === 0 ? resolve() : reject(new Error("设备运行时打包失败，请重试")));
      }),
      new Promise<void>((resolve, reject) => {
        channel.once("error", () => reject(new Error("上传中断，请检查网络后重试")));
        channel.once("close", (code: number | undefined) => code === 0 ? resolve() : reject(new Error("无法部署运行时，请检查设备用户目录是否可写")));
        timeout = setTimeout(() => reject(new Error("上传运行时超时，请检查网络后重试")), 120_000);
      }),
    ]);
  } catch (error) {
    archive.kill(); channel.destroy();
    // Stream errors can contain local paths. Show a bounded, actionable message instead.
    throw error instanceof Error && /^(无法|设备|上传)/.test(error.message)
      ? error : new Error("上传运行时失败，请检查设备空间和网络后重试");
  } finally { if (timeout) clearTimeout(timeout); }
}

/** Direct password/key connections use the bundled SSH client; no OpenSSH setup is required. */
export class ManualSshLauncher {
  constructor(private readonly payloadRoot: string | undefined, private readonly connections: SshConnectionService) {}

  async start(environment: SshEnvironment): Promise<ReceiverEndpoint> {
    const profile = environment.sshConnection;
    if (!profile?.hostFingerprint) throw new Error("请先测试连接并确认设备身份，再开始监控");
    const { client } = await this.connections.connect(profile);
    let control: ClientChannel | undefined;
    let closeTunnel: (() => Promise<void>) | undefined;
    try {
      const architecture = (await runCommand(client, "uname -m")).trim();
      const arch = /^(aarch64|arm64)$/.test(architecture) ? "arm64" : /^(x86_64|amd64)$/.test(architecture) ? "x64" : undefined;
      if (!arch) throw new Error("设备架构暂不支持，需要 Linux x64 或 ARM64");
      if (!this.payloadRoot) throw new Error("安装包缺少设备运行时，请安装完整版本 VibeMate");
      const payload = join(this.payloadRoot, arch);
      try { await access(join(payload, "runtime", "node")); }
      catch { throw new Error(`缺少 Linux ${arch} 运行时，请安装完整版本 VibeMate`); }
      await uploadPayload(client, payload);
      await runCommand(client, '"$HOME/.vibemate/runtime/node" "$HOME/.vibemate/app/hook-installer/dist/cli.js" install', 30_000);
      control = await openCommand(client, 'exec env VIBEMATE_MANAGED=1 "$HOME/.vibemate/runtime/node" "$HOME/.vibemate/app/receiver/dist/cli.js"');
      // Keep consuming stdout after ready, and always handle channel errors.
      control.on("error", () => undefined);
      const ready = await receiverReady(control);
      const tunnel = await this.createTunnel(client, ready.port);
      closeTunnel = tunnel.stop;
      const activeControl = control;
      if (activeControl.destroyed || activeControl.readableEnded) throw new Error("设备接收服务已退出，请重试");
      activeControl.once("close", () => client.end());
      let stopped = false;
      return {
        url: `ws://127.0.0.1:${tunnel.port}/v1/stream`, authToken: ready.authToken,
        stop: async () => {
          if (stopped) return;
          stopped = true;
          try {
            if (!activeControl.destroyed && !activeControl.writableEnded) {
              await new Promise<void>(resolve => {
                const finish = () => { clearTimeout(timer); activeControl.off("close", finish); resolve(); };
                const timer = setTimeout(finish, 2_000);
                activeControl.once("close", finish);
                activeControl.write('{"type":"shutdown"}\n', error => { if (error) finish(); });
              });
            }
          } finally {
            await tunnel.stop(); activeControl.destroy(); client.end();
          }
        },
      };
    } catch (error) {
      await closeTunnel?.(); control?.destroy(); client.destroy(); throw error;
    }
  }

  private async createTunnel(client: Client, remotePort: number): Promise<{ port: number; stop: () => Promise<void> }> {
    const sockets = new Set<Socket>();
    const channels = new Set<ClientChannel>();
    const server = createServer(socket => {
      sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.on("error", () => socket.destroy());
      client.forwardOut("127.0.0.1", 0, "127.0.0.1", remotePort, (error, stream) => {
        if (error || socket.destroyed) { stream?.destroy(); socket.destroy(); return; }
        channels.add(stream);
        stream.on("error", () => { socket.destroy(); stream.destroy(); });
        stream.once("close", () => { channels.delete(stream); socket.destroy(); });
        socket.once("close", () => stream.destroy());
        socket.pipe(stream).pipe(socket);
      });
    });
    let stopping: Promise<void> | undefined;
    const stop = () => stopping ??= new Promise<void>(resolve => {
      client.off("close", onClose);
      for (const socket of sockets) socket.destroy();
      for (const channel of channels) channel.destroy();
      server.close(() => resolve());
    });
    const onClose = () => { void stop(); };
    client.once("close", onClose);
    server.on("error", () => { void stop(); });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject); server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("无法建立设备连接");
      return { port: address.port, stop };
    } catch { await stop(); throw new Error("无法建立本机连接，请重试"); }
  }
}
