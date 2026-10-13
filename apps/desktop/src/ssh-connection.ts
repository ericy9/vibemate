import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isIP } from "node:net";
import ssh2, { type Client as SshClient, type ClientChannel } from "ssh2";
import type { SshConnectionSettings, SshConnectionTest, SshCredentials, SshDeviceInput } from "./environment-types.js";

export interface HostIdentity { host: string; port: number; fingerprint: string }
export type ConfirmHost = (identity: HostIdentity) => Promise<boolean>;

const PROBE = `PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.cargo/bin:$PATH"; export PATH
printf 'os='; uname -s
printf 'arch='; uname -m
printf 'hostname='; hostname
if command -v tar >/dev/null 2>&1; then printf 'tar=yes\\n'; fi
if command -v codex >/dev/null 2>&1; then printf 'codex=yes\\n'; fi
if command -v copilot >/dev/null 2>&1; then printf 'copilot=yes\\n'; fi`;
const VERIFICATION_TTL = 5 * 60_000;
const { Client } = ssh2;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("设备连接信息格式不正确");
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength || /[\x00-\x1f\x7f]/.test(value)) {
    throw new TypeError(`请填写有效的${field}`);
  }
  return value.trim();
}

export function parseSshDeviceInput(value: unknown): SshDeviceInput {
  const input = record(value);
  const name = boundedText(input.name, "设备名称", 80);
  const host = boundedText(input.host, "主机地址", 253);
  if (!isIP(host) && !/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host)) {
    throw new TypeError("主机地址应为 IP 或域名，不包含用户名、端口或空格");
  }
  const port = input.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) throw new TypeError("SSH 端口应为 1 到 65535");
  const username = boundedText(input.username, "登录用户名", 64);
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(username)) throw new TypeError("登录用户名格式不正确");
  if (input.authentication !== "password" && input.authentication !== "key") throw new TypeError("请选择密码或 SSH 密钥登录");
  return {
    name, host, port, username, authentication: input.authentication,
    ...(input.authentication === "key" ? { privateKeyPath: boundedText(input.privateKeyPath, "私钥文件路径", 4096) } : {}),
  };
}

export function parseSshCredentials(value: unknown): SshCredentials {
  const input = record(value ?? {});
  const result: SshCredentials = {};
  for (const field of ["password", "passphrase"] as const) {
    const secret = input[field];
    if (secret === undefined || secret === "") continue;
    if (typeof secret !== "string" || secret.length > 4096 || secret.includes("\0")) throw new TypeError("登录凭证格式不正确");
    result[field] = secret;
  }
  return result;
}

export function connectionKey(profile: SshConnectionSettings): string {
  return JSON.stringify([profile.host.toLowerCase(), profile.port, profile.username, profile.authentication, profile.privateKeyPath ?? ""]);
}

export function connectionSettings(input: SshDeviceInput, fingerprint?: string): SshConnectionSettings {
  return {
    host: input.host, port: input.port, username: input.username, authentication: input.authentication,
    ...(input.privateKeyPath ? { privateKeyPath: input.privateKeyPath } : {}),
    ...(fingerprint ? { hostFingerprint: fingerprint } : {}),
  };
}

export function openCommand(client: SshClient, command: string): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, channel) => error ? reject(new Error("无法在设备上执行命令，请检查 SSH 登录权限")) : resolve(channel));
  });
}

export async function runCommand(client: SshClient, command: string, timeoutMs = 15_000): Promise<string> {
  const channel = await openCommand(client, command);
  return new Promise((resolve, reject) => {
    let output = "";
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) { channel.close(); reject(error); } else resolve(output);
    };
    const timer = setTimeout(() => finish(new Error("设备响应超时，请检查网络后重试")), timeoutMs);
    channel.on("data", (data: Buffer) => {
      output += data.toString("utf8");
      if (Buffer.byteLength(output) > 64 * 1024) finish(new Error("设备返回的数据过多，无法完成检查"));
    });
    channel.stderr.resume();
    channel.once("error", () => finish(new Error("设备连接中断，请重新测试连接")));
    channel.once("close", (code: number | undefined) => finish(code === 0 ? undefined : new Error("设备命令未成功完成，请检查用户权限和运行环境")));
    channel.end();
  });
}

interface Verification {
  key: string;
  connection: SshConnectionSettings;
  credentials: SshCredentials;
  timer: NodeJS.Timeout;
}

/** Passwords/passphrases live only here in main-process memory, never in settings or snapshots. */
export class SshConnectionService {
  private readonly credentials = new Map<string, SshCredentials>();
  private readonly verifications = new Map<string, Verification>();
  private readonly trustedHosts = new Map<string, string>();

  constructor(private readonly confirmHost: ConfirmHost) {}

  async connect(profile: SshConnectionSettings, supplied: SshCredentials = {}): Promise<{ client: SshClient; fingerprint: string }> {
    const credentials = { ...this.credentials.get(connectionKey(profile)), ...supplied };
    if (profile.authentication === "password" && credentials.password === undefined) throw new Error("请输入设备登录密码，再测试连接");
    let privateKey: Buffer | undefined;
    if (profile.authentication === "key") {
      if (!profile.privateKeyPath) throw new Error("请选择 SSH 私钥文件");
      try {
        const metadata = await stat(profile.privateKeyPath);
        if (!metadata.isFile() || metadata.size > 64 * 1024) throw new Error();
        privateKey = await readFile(profile.privateKeyPath);
      } catch { throw new Error("无法读取私钥文件，请重新选择可用的 SSH 私钥"); }
    }
    const client = new Client();
    let fingerprint = "";
    let trustError: Error | undefined;
    // Handle errors after ready as well. Endpoint owners observe close to release their streams.
    client.on("error", () => undefined);
    return new Promise((resolve, reject) => {
      let ready = false;
      const fail = (error: Error) => {
        if (ready) return;
        client.destroy();
        reject(trustError ?? error);
      };
      client.once("ready", () => { ready = true; resolve({ client, fingerprint }); });
      client.once("close", () => fail(new Error("连接已关闭，请检查地址和网络后重试")));
      client.once("error", (error: Error & { level?: string; code?: string }) => {
        const message = error.level === "client-authentication"
          ? "登录失败，请检查用户名、密码或密钥口令"
          : error.code === "ENOTFOUND" ? "找不到设备地址，请检查主机地址"
            : error.code === "ECONNREFUSED" ? "设备未接受 SSH 连接，请检查端口和 SSH 服务"
              : "无法连接设备，请检查网络、SSH 服务和登录凭证";
        fail(new Error(message));
      });
      try {
        client.connect({
          host: profile.host, port: profile.port, username: profile.username,
          readyTimeout: 60_000, keepaliveInterval: 3_000, keepaliveCountMax: 3,
          ...(profile.authentication === "password" ? { password: credentials.password! } : {
            privateKey: privateKey!, ...(credentials.passphrase ? { passphrase: credentials.passphrase } : {}),
          }),
          hostVerifier: (key: Buffer, verify: (accepted: boolean) => void) => {
            fingerprint = `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
            const identity = JSON.stringify([profile.host.toLowerCase(), profile.port]);
            const trusted = profile.hostFingerprint ?? this.trustedHosts.get(identity);
            if (trusted) {
              if (trusted !== fingerprint) trustError = new Error("设备身份已改变。连接已停止，请向设备管理者核对后重新添加设备");
              verify(trusted === fingerprint);
              return;
            }
            void this.confirmHost({ host: profile.host, port: profile.port, fingerprint }).then(accepted => {
              if (accepted) this.trustedHosts.set(identity, fingerprint);
              else trustError = new Error("已取消连接，设备身份尚未确认");
              verify(accepted);
            }).catch(() => { trustError = new Error("无法确认设备身份，请重新测试连接"); verify(false); });
          },
        });
      } catch { fail(new Error("无法使用所选密钥，请检查私钥文件和密钥口令")); }
    });
  }

  async test(input: SshDeviceInput, supplied: SshCredentials, trustedFingerprint?: string): Promise<SshConnectionTest> {
    const profile = connectionSettings(input, trustedFingerprint);
    const credentials = { ...this.credentials.get(connectionKey(profile)), ...supplied };
    const { client, fingerprint } = await this.connect(profile, credentials);
    try {
      const output = await runCommand(client, PROBE);
      const fields = new Map(output.split(/\r?\n/).map(line => {
        const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)] as const;
      }));
      if (fields.get("os") !== "Linux") throw new Error("目前仅支持 Linux 和树莓派设备");
      const rawArch = fields.get("arch") ?? "";
      const architecture = /^(aarch64|arm64)$/.test(rawArch) ? "arm64" : /^(x86_64|amd64)$/.test(rawArch) ? "x64" : undefined;
      if (!architecture) throw new Error("设备架构暂不支持，需要 Linux x64 或 ARM64");
      if (fields.get("tar") !== "yes") throw new Error("设备缺少 tar 工具，请先安装后重新测试");
      if (this.verifications.size >= 64) throw new Error("连接检查次数过多，请稍后重试");
      const verificationId = randomUUID();
      const timer = setTimeout(() => this.verifications.delete(verificationId), VERIFICATION_TTL);
      timer.unref();
      this.verifications.set(verificationId, { key: connectionKey(profile), connection: connectionSettings(input, fingerprint), credentials, timer });
      return {
        verificationId, hostname: (fields.get("hostname") ?? input.host).slice(0, 253), architecture,
        agents: { codex: fields.get("codex") === "yes", copilot: fields.get("copilot") === "yes" },
      };
    } finally { client.end(); }
  }

  takeVerification(id: string, input: SshDeviceInput): { connection: SshConnectionSettings; credentials: SshCredentials } {
    const verification = this.verifications.get(id);
    if (!verification || verification.key !== connectionKey(input)) throw new Error("连接检查已失效或信息已修改，请重新测试连接");
    clearTimeout(verification.timer);
    this.verifications.delete(id);
    return { connection: verification.connection, credentials: verification.credentials };
  }

  remember(profile: SshConnectionSettings, credentials: SshCredentials): void {
    this.credentials.set(connectionKey(profile), { ...credentials });
  }

  forget(profile: SshConnectionSettings): void { this.credentials.delete(connectionKey(profile)); }

  forgetHost(profile: SshConnectionSettings): void {
    this.trustedHosts.delete(JSON.stringify([profile.host.toLowerCase(), profile.port]));
    for (const [id, verification] of this.verifications) {
      if (verification.connection.host.toLowerCase() === profile.host.toLowerCase() && verification.connection.port === profile.port) {
        clearTimeout(verification.timer); this.verifications.delete(id);
      }
    }
  }

  clear(): void {
    this.credentials.clear(); this.trustedHosts.clear();
    for (const verification of this.verifications.values()) clearTimeout(verification.timer);
    this.verifications.clear();
  }
}
