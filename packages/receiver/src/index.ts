import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "@vibemate/adapter-codex";
import { type AdapterRuntimeOptions } from "@vibemate/adapter-common";
import { CopilotAdapter } from "@vibemate/adapter-copilot";
import { PermissionBroker, SessionStore } from "@vibemate/core";
import { PROTOCOL_VERSION } from "@vibemate/protocol";
import { ReceiverRouter } from "./router.js";
import {
  ReceiverLanServer,
  type LanServerAddress,
} from "./lan-server.js";
import {
  acquireRuntimeLock,
  releaseRuntimeLock,
  removeOwnedRuntimeConfig,
  writeRuntimeConfig,
  type RuntimeConfig,
  type RuntimeLock,
} from "./runtime-config.js";

const LOOPBACK_HOST = "127.0.0.1" as const;

export interface ReceiverAddress {
  host: typeof LOOPBACK_HOST;
  port: number;
}

export interface ReceiverOptions {
  codexApprovalsEnabled?: boolean;
  sourceProfile?: string;
  runtimeFilePath?: string;
  adapterRuntime?: Omit<AdapterRuntimeOptions, "sourceProfile">;
  onError?: (error: Error) => void;
  lan?: {
    host: string;
    port?: number;
    authToken: string;
    heartbeatIntervalMs?: number;
    heartbeatTimeoutMs?: number;
  };
}

export class VibeMateReceiver {
  readonly sessions: SessionStore;
  readonly permissions: PermissionBroker;
  private readonly codex: CodexAdapter;
  private readonly copilot: CopilotAdapter;
  private readonly runtimeFilePath: string;
  private readonly onError: (error: Error) => void;
  private readonly router: ReceiverRouter;
  private server: Server | undefined;
  private address: ReceiverAddress | undefined;
  private runtimeLock: RuntimeLock | undefined;
  private authToken: string | undefined;
  private readonly lanOptions: ReceiverOptions["lan"];
  private lanServer: ReceiverLanServer | undefined;
  private lanAddress: LanServerAddress | undefined;

  constructor(options: ReceiverOptions = {}) {
    this.sessions = new SessionStore();
    this.permissions = new PermissionBroker({
      ...(options.adapterRuntime?.now ? { now: options.adapterRuntime.now } : {}),
    });
    const adapterOptions = {
      ...options.adapterRuntime,
      sourceProfile: options.sourceProfile ?? "local",
    };
    this.codex = new CodexAdapter(adapterOptions);
    this.copilot = new CopilotAdapter(adapterOptions);
    this.runtimeFilePath = options.runtimeFilePath
      ?? join(homedir(), ".vibemate", "runtime.json");
    this.onError = options.onError ?? ((error) => console.error(error.message));
    this.lanOptions = options.lan;
    // Standalone HTTP observers retain their existing decision workflow.
    this.permissions.setControllerAvailable(!this.lanOptions && options.codexApprovalsEnabled === true);
    this.router = new ReceiverRouter({
      sessions: this.sessions,
      permissions: this.permissions,
      codex: this.codex,
      copilot: this.copilot,
      getAuthToken: () => this.authToken,
      onError: this.onError,
    });
  }

  async start(port = 0): Promise<ReceiverAddress> {
    if (this.server) {
      throw new Error("receiver is already started");
    }

    const runtimeLock = await acquireRuntimeLock(this.runtimeFilePath);
    this.runtimeLock = runtimeLock;
    const server = createServer((request, response) => {
      void this.router.route(request, response);
    });
    this.server = server;

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, LOOPBACK_HOST);
      });
    } catch (error) {
      this.server = undefined;
      server.removeAllListeners();
      this.runtimeLock = undefined;
      await releaseRuntimeLock(runtimeLock);
      throw error;
    }

    const bound = server.address();
    if (!bound || typeof bound === "string") {
      await this.closeServer();
      this.runtimeLock = undefined;
      await releaseRuntimeLock(runtimeLock);
      throw new Error("receiver did not bind to a TCP address");
    }

    this.address = { host: LOOPBACK_HOST, port: bound.port };
    this.authToken = randomBytes(32).toString("base64url");
    const runtime: RuntimeConfig = {
      protocolVersion: PROTOCOL_VERSION,
      ...this.address,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      authToken: this.authToken,
    };
    try {
      await writeRuntimeConfig(this.runtimeFilePath, runtime);
      if (this.lanOptions) {
        const lanServer = new ReceiverLanServer({
          ...this.lanOptions,
          sessions: this.sessions,
          permissions: this.permissions,
          onError: this.onError,
        });
        this.lanServer = lanServer;
        this.lanAddress = await lanServer.start();
      }
    } catch (error) {
      await this.closeLanServer();
      await this.closeServer();
      await removeOwnedRuntimeConfig(this.runtimeFilePath, {
        pid: process.pid,
        port: this.address?.port ?? runtime.port,
      });
      this.authToken = undefined;
      this.runtimeLock = undefined;
      await releaseRuntimeLock(runtimeLock);
      throw error;
    }
    return this.address;
  }

  async stop(): Promise<void> {
    this.permissions.shutdown();
    const address = this.address;
    const runtimeLock = this.runtimeLock;
    try {
      await this.closeLanServer();
      await this.closeServer();
      if (address) {
        await removeOwnedRuntimeConfig(this.runtimeFilePath, {
          pid: process.pid,
          port: address.port,
        });
      }
    } finally {
      this.authToken = undefined;
      this.runtimeLock = undefined;
      if (runtimeLock) {
        await releaseRuntimeLock(runtimeLock);
      }
    }
  }

  getLanAddress(): LanServerAddress | undefined {
    return this.lanAddress ? { ...this.lanAddress } : undefined;
  }

  private async closeServer(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.address = undefined;
    if (!server) {
      return;
    }
    if (!server.listening) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  private async closeLanServer(): Promise<void> {
    const lanServer = this.lanServer;
    this.lanServer = undefined;
    this.lanAddress = undefined;
    if (lanServer) {
      await lanServer.stop();
    }
  }
}

export * from "./runtime-config.js";
export * from "./lan-server.js";
