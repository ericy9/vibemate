import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { CodexAdapter, formatCodexPermissionOutcome } from "@vibemate/adapter-codex";
import { AdapterInputError, type AdapterRuntimeOptions } from "@vibemate/adapter-common";
import { CopilotAdapter, formatCopilotPermissionOutcome } from "@vibemate/adapter-copilot";
import {
  PermissionBroker,
  SessionStore,
  type PermissionOutcome,
} from "@vibemate/core";
import {
  parsePermissionDecision,
  PROTOCOL_VERSION,
} from "@vibemate/protocol";
import {
  acquireRuntimeLock,
  releaseRuntimeLock,
  removeOwnedRuntimeConfig,
  writeRuntimeConfig,
  type RuntimeConfig,
  type RuntimeLock,
} from "./runtime-config.js";

const LOOPBACK_HOST = "127.0.0.1" as const;
const MAX_RAW_HOOK_BYTES = 256 * 1024;
const MAX_DECISION_BYTES = 16 * 1024;

class PayloadTooLargeError extends Error {}
class UnsupportedMediaTypeError extends Error {}

export interface ReceiverAddress {
  host: typeof LOOPBACK_HOST;
  port: number;
}

export interface ReceiverOptions {
  sourceProfile?: string;
  runtimeFilePath?: string;
  adapterRuntime?: Omit<AdapterRuntimeOptions, "sourceProfile">;
  onError?: (error: Error) => void;
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") {
    throw new UnsupportedMediaTypeError("content-type must be application/json");
  }

  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      throw new PayloadTooLargeError(`payload exceeds ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }

  const body = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(body);
}

export class VibeMateReceiver {
  readonly sessions: SessionStore;
  readonly permissions: PermissionBroker;
  private readonly codex: CodexAdapter;
  private readonly copilot: CopilotAdapter;
  private readonly runtimeFilePath: string;
  private readonly onError: (error: Error) => void;
  private server: Server | undefined;
  private address: ReceiverAddress | undefined;
  private runtimeLock: RuntimeLock | undefined;
  private authToken: string | undefined;

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
  }

  async start(port = 0): Promise<ReceiverAddress> {
    if (this.server) {
      throw new Error("receiver is already started");
    }

    const runtimeLock = await acquireRuntimeLock(this.runtimeFilePath);
    this.runtimeLock = runtimeLock;
    const server = createServer((request, response) => {
      void this.route(request, response);
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
    } catch (error) {
      await this.closeServer();
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

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}`);

      if (!this.isAuthorized(request)) {
        request.resume();
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, {
          ok: true,
          protocolVersion: PROTOCOL_VERSION,
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        sendJson(response, 200, {
          sessions: this.sessions.list(),
          pendingPermissions: this.permissions.listPending(),
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/hooks/codex") {
        const result = this.codex.adapt(await readJson(request, MAX_RAW_HOOK_BYTES));
        await this.handleAdapterResult("codex", result, request, response);
        return;
      }

      const copilotMatch = url.pathname.match(/^\/v1\/hooks\/copilot\/([a-zA-Z]+)$/);
      if (request.method === "POST" && copilotMatch?.[1]) {
        const result = this.copilot.adapt(
          copilotMatch[1],
          await readJson(request, MAX_RAW_HOOK_BYTES),
        );
        await this.handleAdapterResult("copilot", result, request, response);
        return;
      }

      const decisionMatch = url.pathname.match(/^\/v1\/permissions\/([^/]+)\/decision$/);
      if (request.method === "POST" && decisionMatch?.[1]) {
        const decision = parsePermissionDecision(await readJson(request, MAX_DECISION_BYTES));
        if (decision.requestId !== decisionMatch[1]) {
          sendJson(response, 409, { result: "identity_mismatch" });
          return;
        }
        const result = this.permissions.submitDecision(decision);
        const statusCode = result === "accepted"
          ? 200
          : result === "not_found"
            ? 404
            : 409;
        sendJson(response, statusCode, { result });
        return;
      }

      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      this.handleRouteError(error, response);
    }
  }

  private async handleAdapterResult(
    agent: "codex" | "copilot",
    result: ReturnType<CodexAdapter["adapt"]> | ReturnType<CopilotAdapter["adapt"]>,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (result.kind === "ignored") {
      sendJson(response, 202, { result: "ignored", reason: result.reason });
      return;
    }

    const applied = this.sessions.apply(result.event);
    if (result.kind === "event") {
      sendJson(response, 202, { result: applied.result });
      return;
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    request.once("aborted", abort);
    response.once("close", () => {
      if (!response.writableEnded) {
        abort();
      }
    });
    const outcome = await this.permissions.waitForDecision(result.request, controller.signal);
    this.sendPermissionOutcome(agent, outcome, response);
  }

  private sendPermissionOutcome(
    agent: "codex" | "copilot",
    outcome: PermissionOutcome,
    response: ServerResponse,
  ): void {
    if (response.destroyed) {
      return;
    }
    if (agent === "codex") {
      const body = formatCodexPermissionOutcome(outcome);
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
      });
      response.end(body);
      return;
    }

    const output = formatCopilotPermissionOutcome(outcome);
    if (output.statusCode === 204) {
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(output.body),
    });
    response.end(output.body);
  }

  private handleRouteError(error: unknown, response: ServerResponse): void {
    if (response.headersSent || response.destroyed) {
      return;
    }
    if (error instanceof PayloadTooLargeError) {
      sendJson(response, 413, { error: "payload_too_large" });
      return;
    }
    if (error instanceof UnsupportedMediaTypeError) {
      sendJson(response, 415, { error: "unsupported_media_type" });
      return;
    }
    if (error instanceof SyntaxError) {
      sendJson(response, 400, { error: "invalid_json" });
      return;
    }
    if (error instanceof AdapterInputError) {
      sendJson(response, 422, { error: "invalid_hook_payload", message: error.message });
      return;
    }
    if (error instanceof Error && error.name === "ZodError") {
      sendJson(response, 422, { error: "invalid_protocol_payload" });
      return;
    }

    const safeError = error instanceof Error ? error : new Error("unknown receiver error");
    this.onError(safeError);
    sendJson(response, 500, { error: "internal_error" });
  }

  private isAuthorized(request: IncomingMessage): boolean {
    const provided = request.headers["x-vibemate-token"];
    if (typeof provided !== "string" || !this.authToken) {
      return false;
    }
    const expectedBuffer = Buffer.from(this.authToken);
    const providedBuffer = Buffer.from(provided);
    return expectedBuffer.length === providedBuffer.length
      && timingSafeEqual(expectedBuffer, providedBuffer);
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
}

export * from "./runtime-config.js";
