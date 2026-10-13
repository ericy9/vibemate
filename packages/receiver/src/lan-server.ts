import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { parsePermissionDecision, PROTOCOL_VERSION } from "@vibemate/protocol";
import { WebSocket, WebSocketServer } from "ws";
import type { PermissionBroker, SessionStore } from "@vibemate/core";

const MAX_MESSAGE_BYTES = 32 * 1024;

export interface ReceiverSnapshot {
  sessions: ReturnType<SessionStore["list"]>;
  pendingPermissions: ReturnType<PermissionBroker["listPending"]>;
}

export interface LanServerOptions {
  host: string;
  port?: number;
  authToken: string;
  sessions: SessionStore;
  permissions: PermissionBroker;
  onError: (error: Error) => void;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
}

export interface LanServerAddress {
  host: string;
  port: number;
}

interface DecisionMessage {
  type: "permission_decision";
  commandId: string;
  decision: unknown;
}

function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length === providedBuffer.length
    && timingSafeEqual(expectedBuffer, providedBuffer);
}

export class ReceiverLanServer {
  private server: Server | undefined;
  private webSocketServer: WebSocketServer | undefined;
  private unsubscribeSessions: (() => void) | undefined;
  private unsubscribePermissions: (() => void) | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private readonly controllers = new Map<WebSocket, { deadline: number; timer: NodeJS.Timeout; approvals: boolean }>();
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;

  constructor(private readonly options: LanServerOptions) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 3_000;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 9_000;
    if (!Number.isSafeInteger(this.heartbeatIntervalMs) || this.heartbeatIntervalMs <= 0
      || !Number.isSafeInteger(this.heartbeatTimeoutMs) || this.heartbeatTimeoutMs <= this.heartbeatIntervalMs) {
      throw new TypeError("heartbeat timeout must exceed a positive heartbeat interval");
    }
    this.options.permissions.setControllerAvailable(false);
  }

  async start(): Promise<LanServerAddress> {
    if (this.server) {
      throw new Error("LAN server is already started");
    }

    const server = createServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ok: true, protocolVersion: PROTOCOL_VERSION }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    const webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_MESSAGE_BYTES,
    });

    server.on("upgrade", (request, socket, head) => {
      const authorization = request.headers.authorization;
      const token = authorization?.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length)
        : undefined;
      if (request.url !== "/v1/stream" || !tokenMatches(token, this.options.authToken)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit("connection", webSocket, request);
      });
    });

    webSocketServer.on("connection", (webSocket) => {
      this.renewController(webSocket);
      // The desktop's ws client automatically replies to protocol ping frames.
      webSocket.on("pong", () => {
        this.expireControllers();
        if (this.controllers.has(webSocket)) this.renewController(webSocket);
      });
      webSocket.on("close", () => this.removeController(webSocket));
      this.sendSnapshot(webSocket);
      webSocket.on("message", (data, isBinary) => {
        if (isBinary) {
          webSocket.close(1003, "text messages only");
          return;
        }
        this.handleMessage(webSocket, data.toString());
      });
      webSocket.on("error", (error) => this.options.onError(error));
    });

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
      server.listen(this.options.port ?? 0, this.options.host);
    });

    this.server = server;
    this.webSocketServer = webSocketServer;
    this.heartbeatTimer = setInterval(() => {
      this.expireControllers();
      for (const client of this.controllers.keys()) {
        if (client.readyState === WebSocket.OPEN) client.ping();
      }
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
    this.unsubscribeSessions = this.options.sessions.subscribe(() => this.broadcastSnapshot());
    this.unsubscribePermissions = this.options.permissions.subscribe(
      () => this.broadcastSnapshot(),
    );

    const address = server.address();
    if (!address || typeof address === "string") {
      await this.stop();
      throw new Error("LAN server did not bind to a TCP address");
    }
    return { host: this.options.host, port: address.port };
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    for (const controller of this.controllers.values()) clearTimeout(controller.timer);
    this.controllers.clear();
    this.options.permissions.setControllerAvailable(false);
    this.unsubscribeSessions?.();
    this.unsubscribePermissions?.();
    this.unsubscribeSessions = undefined;
    this.unsubscribePermissions = undefined;

    const webSocketServer = this.webSocketServer;
    this.webSocketServer = undefined;
    if (webSocketServer) {
      for (const client of webSocketServer.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
    }

    const server = this.server;
    this.server = undefined;
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  }

  private getSnapshot(): ReceiverSnapshot {
    return {
      sessions: this.options.sessions.list(),
      pendingPermissions: this.options.permissions.listPending(),
    };
  }

  private renewController(client: WebSocket): void {
    const previous = this.controllers.get(client);
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(() => {
      this.removeController(client);
      client.terminate();
    }, this.heartbeatTimeoutMs);
    timer.unref();
    this.controllers.set(client, { deadline: performance.now() + this.heartbeatTimeoutMs, timer, approvals: previous?.approvals ?? false });
    this.updateApprovalAvailability();
  }

  private removeController(client: WebSocket): void {
    const controller = this.controllers.get(client);
    if (controller) clearTimeout(controller.timer);
    this.controllers.delete(client);
    this.updateApprovalAvailability();
  }

  private updateApprovalAvailability(): void {
    this.options.permissions.setControllerAvailable([...this.controllers.values()].some(client => client.approvals));
  }

  private expireControllers(): void {
    for (const [client, controller] of this.controllers) {
      if (client.readyState !== WebSocket.OPEN || controller.deadline <= performance.now()) {
        this.removeController(client);
        client.terminate();
      }
    }
  }

  private sendSnapshot(webSocket: WebSocket): void {
    if (webSocket.readyState !== WebSocket.OPEN) return;
    webSocket.send(JSON.stringify({
      type: "snapshot",
      protocolVersion: PROTOCOL_VERSION,
      snapshot: this.getSnapshot(),
    }));
  }

  private broadcastSnapshot(): void {
    if (!this.webSocketServer) return;
    for (const client of this.webSocketServer.clients) {
      this.sendSnapshot(client);
    }
  }

  private handleMessage(webSocket: WebSocket, raw: string): void {
    this.expireControllers();
    if (!this.controllers.has(webSocket)) return;
    let message: DecisionMessage;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && "type" in parsed && parsed.type === "set_codex_approvals") {
        if (!("enabled" in parsed) || typeof parsed.enabled !== "boolean"
          || !("commandId" in parsed) || typeof parsed.commandId !== "string") throw new TypeError("invalid approval setting");
        this.controllers.get(webSocket)!.approvals = parsed.enabled;
        this.updateApprovalAvailability();
        webSocket.send(JSON.stringify({ type: "permission_decision_result", commandId: parsed.commandId, result: "accepted" }));
        return;
      }
      if (
        !parsed
        || typeof parsed !== "object"
        || !("type" in parsed)
        || parsed.type !== "permission_decision"
        || !("commandId" in parsed)
        || typeof parsed.commandId !== "string"
        || !("decision" in parsed)
      ) {
        throw new TypeError("invalid LAN message");
      }
      message = parsed as DecisionMessage;
      if (!this.controllers.get(webSocket)?.approvals) throw new TypeError("desktop approvals are disabled");
      const decision = parsePermissionDecision(message.decision);
      const result = this.options.permissions.submitDecision(decision);
      webSocket.send(JSON.stringify({
        type: "permission_decision_result",
        commandId: message.commandId,
        result,
      }));
    } catch (error) {
      const safeError = error instanceof Error ? error : new Error("invalid LAN message");
      this.options.onError(safeError);
      webSocket.close(1007, "invalid message");
    }
  }
}
