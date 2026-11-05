import { randomBytes } from "node:crypto";
import { parsePermissionDecision } from "@vibemate/protocol";
import { VibeMateReceiver } from "@vibemate/receiver";
import type { DesktopConfiguration, AggregatedSnapshot, EnvironmentConfig, EnvironmentStatus } from "./environment-types.js";
import { projectName } from "./task-notifier.js";
import { RemoteReceiverClient } from "./remote-receiver-client.js";

export interface ReceiverEndpoint {
  url: string;
  authToken: string;
  stop: () => Promise<void>;
}

export interface EnvironmentLauncher {
  start(environment: EnvironmentConfig): Promise<ReceiverEndpoint>;
}

interface Connection {
  client?: RemoteReceiverClient | undefined;
  endpoint?: ReceiverEndpoint | undefined;
  status: EnvironmentStatus;
  error?: string | undefined;
  manuallyStarted: boolean;
  unsubscribe?: (() => void) | undefined;
}

export interface PermissionIdentity {
  environmentId: string;
  requestId: string;
  sourceProfile: string;
  agent: "codex" | "copilot";
  sessionId: string;
}

export class ReceiverConnectionManager {
  private readonly connections = new Map<string, Connection>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private configuration: DesktopConfiguration,
    private readonly launcher: EnvironmentLauncher,
    private readonly onError: (error: Error) => void = () => undefined,
  ) {
    for (const environment of configuration.environments) {
      this.connections.set(environment.environmentId, { status: "stopped", manuallyStarted: false });
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setConfiguration(configuration: DesktopConfiguration): void {
    this.configuration = configuration;
    for (const environment of configuration.environments) {
      if (!this.connections.has(environment.environmentId)) {
        this.connections.set(environment.environmentId, { status: "stopped", manuallyStarted: false });
      }
    }
    this.notify();
  }

  async start(environmentId: string, manuallyStarted = false): Promise<void> {
    const environment = this.configuration.environments.find((item) => item.environmentId === environmentId);
    if (!environment) throw new Error("environment not found");
    const connection = this.connections.get(environmentId) ?? { status: "stopped", manuallyStarted: false };
    if (connection.status === "starting" || connection.status === "connected") return;
    if (connection.endpoint) await this.stop(environmentId);
    connection.status = "starting";
    connection.error = undefined;
    connection.manuallyStarted ||= manuallyStarted;
    this.connections.set(environmentId, connection);
    this.notify();
    try {
      const endpoint = await this.launcher.start(environment);
      const client = new RemoteReceiverClient({
        url: endpoint.url,
        authToken: endpoint.authToken,
        codexApprovalsEnabled: environment.codexApprovalsEnabled === true,
        onError: this.onError,
      });
      connection.endpoint = endpoint;
      connection.client = client;
      connection.unsubscribe = client.subscribe(() => {
        const status = client.getStatus();
        connection.status = status === "connecting" ? "starting" : status;
        this.notify();
      });
      client.start();
    } catch (error) {
      connection.status = "error";
      connection.error = error instanceof Error ? error.message : "unknown environment startup error";
      this.onError(error instanceof Error ? error : new Error(connection.error));
      this.notify();
      throw error;
    }
  }

  async stop(environmentId: string): Promise<void> {
    const connection = this.connections.get(environmentId);
    if (!connection) return;
    connection.unsubscribe?.();
    connection.unsubscribe = undefined;
    connection.client?.stop();
    connection.client = undefined;
    const endpoint = connection.endpoint;
    connection.endpoint = undefined;
    connection.status = "stopped";
    connection.manuallyStarted = false;
    this.notify();
    if (endpoint) await endpoint.stop();
  }

  async setCodexApprovals(environmentId: string, enabled: boolean): Promise<void> {
    await this.connections.get(environmentId)?.client?.setCodexApprovals(enabled);
  }

  async stopAll(timeoutMs = 3_000): Promise<void> {
    const stops = [...this.connections.keys()].map((id) => this.stop(id).catch(this.onError));
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled(stops).then(() => undefined),
        new Promise<void>((resolve) => { timeout = setTimeout(resolve, timeoutMs); }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  getSnapshot(): AggregatedSnapshot {
    const environmentById = new Map(this.configuration.environments.map((item) => [item.environmentId, item]));
    const sessions: AggregatedSnapshot["sessions"] = [];
    const pendingPermissions: AggregatedSnapshot["pendingPermissions"] = [];
    for (const [environmentId, connection] of this.connections) {
      const environment = environmentById.get(environmentId);
      if (!environment || !connection.client) continue;
      const snapshot = connection.client.getSnapshot();
      const source = { deviceId: environment.deviceId, environmentId, environmentName: environment.name };
      sessions.push(...snapshot.sessions.map((session) => {
        const project = projectName(session);
        return { ...session, ...source, ...(project ? { project } : {}) };
      }));
      pendingPermissions.push(...snapshot.pendingPermissions.map((permission) => ({ ...permission, ...source })));
    }
    sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    pendingPermissions.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
    return {
      devices: structuredClone(this.configuration.devices),
      environments: this.configuration.environments.map((environment) => {
        const connection = this.connections.get(environment.environmentId);
        return {
          ...environment,
          status: connection?.status ?? "stopped",
          manuallyStarted: connection?.manuallyStarted ?? false,
          ...(connection?.error ? { error: connection.error } : {}),
        };
      }),
      sessions,
      pendingPermissions,
      preferences: structuredClone(this.configuration.preferences),
      onboardingCompleted: this.configuration.onboardingCompleted,
    };
  }

  async submitDecision(identity: PermissionIdentity, decision: "allow" | "deny") {
    const connection = this.connections.get(identity.environmentId);
    const request = connection?.client?.getSnapshot().pendingPermissions.find((item) => (
      item.requestId === identity.requestId && item.sourceProfile === identity.sourceProfile
      && item.agent === identity.agent && item.sessionId === identity.sessionId
    ));
    if (!request || !connection?.client) return "not_found" as const;
    return connection.client.submitDecision(parsePermissionDecision({
      protocolVersion: 1,
      requestId: request.requestId,
      sourceProfile: request.sourceProfile,
      agent: request.agent,
      sessionId: request.sessionId,
      decision,
      decidedAt: new Date().toISOString(),
    }));
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export class EmbeddedReceiverLauncher implements EnvironmentLauncher {
  async start(environment: EnvironmentConfig): Promise<ReceiverEndpoint> {
    if (environment.kind !== "windows") throw new Error(`${environment.kind} requires an external launcher`);
    const authToken = randomBytes(32).toString("base64url");
    const receiver = new VibeMateReceiver({
      sourceProfile: environment.environmentId,
      onError: (error) => console.error("Receiver error:", error.message),
      lan: { host: "127.0.0.1", port: 0, authToken },
    });
    await receiver.start();
    const address = receiver.getLanAddress();
    if (!address) {
      await receiver.stop();
      throw new Error("local Receiver stream did not start");
    }
    return {
      url: `ws://${address.host}:${address.port}/v1/stream`,
      authToken,
      stop: () => receiver.stop(),
    };
  }
}
