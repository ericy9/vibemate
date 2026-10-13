import { randomUUID } from "node:crypto";
import {
  parsePermissionDecision,
  type PermissionDecision,
} from "@vibemate/protocol";
import {
  type ReceiverSnapshot,
} from "@vibemate/receiver";
import WebSocket from "ws";

export type RemoteConnectionStatus = "connecting" | "connected" | "disconnected";

export interface RemoteReceiverClientOptions {
  url: string;
  authToken: string;
  onError?: (error: Error) => void;
  codexApprovalsEnabled?: boolean;
}

type DecisionResult = "accepted"
  | "not_found"
  | "identity_mismatch"
  | "expired"
  | "already_finalized";

interface PendingCommand {
  resolve: (result: DecisionResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class RemoteReceiverClient {
  private snapshot: ReceiverSnapshot = { sessions: [], pendingPermissions: [] };
  private status: RemoteConnectionStatus = "disconnected";
  private readonly listeners = new Set<() => void>();
  private readonly pendingCommands = new Map<string, PendingCommand>();
  private readonly onError: (error: Error) => void;
  private webSocket: WebSocket | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectAttempt = 0;
  private stopped = true;
  private codexApprovalsEnabled: boolean;

  constructor(private readonly options: RemoteReceiverClientOptions) {
    this.codexApprovalsEnabled = options.codexApprovalsEnabled === true;
    const url = new URL(options.url);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      throw new Error("remote receiver URL must use ws:// or wss://");
    }
    this.onError = options.onError ?? (() => undefined);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.webSocket?.close(1000, "desktop shutting down");
    this.webSocket = undefined;
    this.setStatus("disconnected");
    for (const command of this.pendingCommands.values()) {
      clearTimeout(command.timeout);
      command.reject(new Error("remote receiver connection closed"));
    }
    this.pendingCommands.clear();
  }

  getSnapshot(): ReceiverSnapshot {
    return structuredClone(this.snapshot);
  }

  getStatus(): RemoteConnectionStatus {
    return this.status;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  submitDecision(value: PermissionDecision): Promise<DecisionResult> {
    const decision = parsePermissionDecision(value);
    return this.sendCommand({ type: "permission_decision", decision });
  }

  async setCodexApprovals(enabled: boolean): Promise<void> {
    if (this.webSocket?.readyState === WebSocket.OPEN) {
      await this.sendCommand({ type: "set_codex_approvals", enabled });
    }
    this.codexApprovalsEnabled = enabled;
  }

  private sendCommand(message: Record<string, unknown>): Promise<DecisionResult> {
    const webSocket = this.webSocket;
    if (!webSocket || webSocket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("remote receiver is not connected"));
    }

    const commandId = randomUUID();
    return new Promise<DecisionResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingCommands.delete(commandId);
        reject(new Error("remote permission decision timed out"));
      }, 10_000);
      this.pendingCommands.set(commandId, { resolve, reject, timeout });
      webSocket.send(JSON.stringify({
        ...message,
        commandId,
      }), (error) => {
        if (!error) return;
        const command = this.pendingCommands.get(commandId);
        if (!command) return;
        this.pendingCommands.delete(commandId);
        clearTimeout(command.timeout);
        command.reject(error);
      });
    });
  }

  private connect(): void {
    if (this.stopped) return;
    this.setStatus("connecting");
    const webSocket = new WebSocket(this.options.url, {
      // Reply to Receiver heartbeat pings on this same connection (no polling process).
      autoPong: true,
      headers: { Authorization: `Bearer ${this.options.authToken}` },
      handshakeTimeout: 10_000,
    });
    this.webSocket = webSocket;

    webSocket.on("open", () => {
      this.reconnectAttempt = 0;
      void this.setCodexApprovals(this.codexApprovalsEnabled).then(() => {
        if (!this.stopped && this.webSocket === webSocket && webSocket.readyState === WebSocket.OPEN) this.setStatus("connected");
      }).catch(error => {
        this.onError(error);
        webSocket.close(1011, "approval configuration failed");
      });
    });
    webSocket.on("message", (data, isBinary) => {
      if (isBinary) return;
      this.handleMessage(data.toString());
    });
    webSocket.on("close", () => {
      // A stopped connection must not invalidate a newly started connection.
      if (this.webSocket !== webSocket) return;
      this.webSocket = undefined;
      this.setStatus("disconnected");
      this.rejectPendingCommands();
      this.scheduleReconnect();
    });
    webSocket.on("error", (error) => {
      this.onError(error);
    });
  }

  private handleMessage(raw: string): void {
    try {
      const message: unknown = JSON.parse(raw);
      if (!message || typeof message !== "object" || !("type" in message)) {
        throw new TypeError("invalid remote receiver message");
      }
      if (message.type === "snapshot" && "snapshot" in message) {
        const snapshot = message.snapshot;
        if (
          !snapshot
          || typeof snapshot !== "object"
          || !("sessions" in snapshot)
          || !Array.isArray(snapshot.sessions)
          || !("pendingPermissions" in snapshot)
          || !Array.isArray(snapshot.pendingPermissions)
        ) {
          throw new TypeError("invalid remote snapshot");
        }
        this.snapshot = structuredClone(snapshot as ReceiverSnapshot);
        this.notify();
        return;
      }
      if (
        message.type === "permission_decision_result"
        && "commandId" in message
        && typeof message.commandId === "string"
        && "result" in message
        && typeof message.result === "string"
      ) {
        const command = this.pendingCommands.get(message.commandId);
        if (!command) return;
        if (![
          "accepted",
          "not_found",
          "identity_mismatch",
          "expired",
          "already_finalized",
        ].includes(message.result)) {
          throw new TypeError("invalid permission decision result");
        }
        this.pendingCommands.delete(message.commandId);
        clearTimeout(command.timeout);
        command.resolve(message.result as DecisionResult);
      }
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error("invalid remote message"));
      this.webSocket?.close(1007, "invalid message");
    }
  }

  private rejectPendingCommands(): void {
    for (const command of this.pendingCommands.values()) {
      clearTimeout(command.timeout);
      command.reject(new Error("remote receiver disconnected"));
    }
    this.pendingCommands.clear();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(1_000 * 2 ** this.reconnectAttempt, 30_000);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private setStatus(status: RemoteConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
