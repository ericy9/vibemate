import {
  createSessionKey,
  type PermissionDecision,
  type PermissionRequest,
} from "@vibemate/protocol";

export type NoDecisionReason =
  | "timeout"
  | "shutdown"
  | "request_aborted"
  | "broker_capacity";

export type PermissionOutcome =
  | {
      requestId: string;
      decision: "allow" | "deny";
      decidedAt: string;
    }
  | {
      requestId: string;
      decision: "no_decision";
      reason: NoDecisionReason;
      decidedAt: string;
    };

export type SubmitDecisionResult =
  | "accepted"
  | "not_found"
  | "identity_mismatch"
  | "expired"
  | "already_finalized";

interface PendingPermission {
  request: PermissionRequest;
  resolve: (outcome: PermissionOutcome) => void;
  expiryTimer?: NodeJS.Timeout;
  abortSignal?: AbortSignal;
  abortHandler?: () => void;
}

export interface PermissionBrokerOptions {
  now?: () => Date;
  maxFinalizedRequests?: number;
  maxPendingRequests?: number;
}

function permissionKey(
  value: Pick<PermissionRequest, "requestId" | "sourceProfile" | "agent" | "sessionId">,
): string {
  return `${createSessionKey(value)}\u0000${value.requestId}`;
}

export class PermissionBroker {
  private readonly pending = new Map<string, PendingPermission>();
  private readonly finalized = new Set<string>();
  private readonly finalizedOrder: string[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly now: () => Date;
  private readonly maxFinalizedRequests: number;
  private readonly maxPendingRequests: number;
  private closed = false;

  constructor(options: PermissionBrokerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.maxFinalizedRequests = options.maxFinalizedRequests ?? 1_000;
    this.maxPendingRequests = options.maxPendingRequests ?? 256;
  }

  waitForDecision(request: PermissionRequest, signal?: AbortSignal): Promise<PermissionOutcome> {
    const key = permissionKey(request);
    if (this.pending.has(key) || this.finalized.has(key)) {
      throw new Error(`permission request already exists: ${request.requestId}`);
    }

    if (this.closed) {
      return this.immediateNoDecision(key, request.requestId, "shutdown");
    }

    if (Date.parse(request.expiresAt) <= this.now().getTime()) {
      return this.immediateNoDecision(key, request.requestId, "timeout");
    }

    if (this.pending.size >= this.maxPendingRequests) {
      return this.immediateNoDecision(key, request.requestId, "broker_capacity");
    }

    return new Promise<PermissionOutcome>((resolve) => {
      const entry: PendingPermission = { request, resolve };
      if (signal) {
        const abortHandler = () => {
          this.finalizeNoDecision(key, "request_aborted");
        };
        entry.abortSignal = signal;
        entry.abortHandler = abortHandler;
        signal.addEventListener("abort", abortHandler, { once: true });
      }
      this.pending.set(key, entry);
      this.scheduleExpiry(key, entry);
      this.notify();

      if (signal?.aborted) {
        this.finalizeNoDecision(key, "request_aborted");
      }
    });
  }

  submitDecision(decision: PermissionDecision): SubmitDecisionResult {
    const key = permissionKey(decision);
    if (this.finalized.has(key)) {
      return "already_finalized";
    }

    const entry = this.pending.get(key);
    if (!entry) {
      if ([...this.pending.values()].some(
        (pending) => pending.request.requestId === decision.requestId,
      )) {
        return "identity_mismatch";
      }
      return "not_found";
    }

    if (Date.parse(entry.request.expiresAt) <= this.now().getTime()) {
      this.finalizeNoDecision(key, "timeout");
      return "expired";
    }

    this.finalize(key, entry, {
      requestId: decision.requestId,
      decision: decision.decision,
      decidedAt: decision.decidedAt,
    });
    return "accepted";
  }

  expire(): number {
    const now = this.now().getTime();
    const expired = [...this.pending.values()]
      .filter((entry) => Date.parse(entry.request.expiresAt) <= now);

    for (const entry of expired) {
      this.finalizeNoDecision(permissionKey(entry.request), "timeout");
    }
    return expired.length;
  }

  shutdown(): number {
    this.closed = true;
    const entries = [...this.pending.values()];
    for (const entry of entries) {
      this.finalizeNoDecision(permissionKey(entry.request), "shutdown");
    }
    return entries.length;
  }

  listPending(): PermissionRequest[] {
    return [...this.pending.values()].map((entry) => structuredClone(entry.request));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private finalizeNoDecision(key: string, reason: NoDecisionReason): void {
    const entry = this.pending.get(key);
    if (!entry) {
      return;
    }
    this.finalize(key, entry, {
      requestId: entry.request.requestId,
      decision: "no_decision",
      reason,
      decidedAt: this.now().toISOString(),
    });
  }

  private finalize(
    key: string,
    entry: PendingPermission,
    outcome: PermissionOutcome,
  ): void {
    this.pending.delete(key);
    if (entry.expiryTimer) {
      clearTimeout(entry.expiryTimer);
    }
    if (entry.abortSignal && entry.abortHandler) {
      entry.abortSignal.removeEventListener("abort", entry.abortHandler);
    }
    this.rememberFinalized(key);
    entry.resolve(outcome);
    this.notify();
  }

  private immediateNoDecision(
    key: string,
    requestId: string,
    reason: NoDecisionReason,
  ): Promise<PermissionOutcome> {
    this.rememberFinalized(key);
    return Promise.resolve({
      requestId,
      decision: "no_decision",
      reason,
      decidedAt: this.now().toISOString(),
    });
  }

  private scheduleExpiry(key: string, entry: PendingPermission): void {
    const remaining = Date.parse(entry.request.expiresAt) - this.now().getTime();
    if (remaining <= 0) {
      this.finalizeNoDecision(key, "timeout");
      return;
    }

    const delay = Math.min(remaining, 2_147_483_647);
    entry.expiryTimer = setTimeout(() => {
      const current = this.pending.get(key);
      if (!current) {
        return;
      }
      if (Date.parse(current.request.expiresAt) <= this.now().getTime()) {
        this.finalizeNoDecision(key, "timeout");
      } else {
        this.scheduleExpiry(key, current);
      }
    }, delay);
  }

  private rememberFinalized(requestId: string): void {
    this.finalized.add(requestId);
    this.finalizedOrder.push(requestId);
    while (this.finalizedOrder.length > this.maxFinalizedRequests) {
      const removed = this.finalizedOrder.shift();
      if (removed) {
        this.finalized.delete(removed);
      }
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
