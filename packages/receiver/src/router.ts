import { timingSafeEqual } from "node:crypto";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { CodexAdapter, formatCodexPermissionOutcome } from "@vibemate/adapter-codex";
import { AdapterInputError } from "@vibemate/adapter-common";
import { CopilotAdapter, formatCopilotPermissionOutcome } from "@vibemate/adapter-copilot";
import { type PermissionBroker, type PermissionOutcome, type SessionStore } from "@vibemate/core";
import { parsePermissionDecision, PROTOCOL_VERSION } from "@vibemate/protocol";
import {
  PayloadTooLargeError,
  readJson,
  sendJson,
  UnsupportedMediaTypeError,
} from "./http.js";

const LOOPBACK_ORIGIN = "http://127.0.0.1";
const MAX_RAW_HOOK_BYTES = 256 * 1024;
const MAX_DECISION_BYTES = 16 * 1024;

export interface ReceiverRouterOptions {
  sessions: SessionStore;
  permissions: PermissionBroker;
  codex: CodexAdapter;
  copilot: CopilotAdapter;
  getAuthToken: () => string | undefined;
  onError: (error: Error) => void;
}

export class ReceiverRouter {
  constructor(private readonly options: ReceiverRouterOptions) {}

  async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", LOOPBACK_ORIGIN);

      if (!this.isAuthorized(request)) {
        request.resume();
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { ok: true, protocolVersion: PROTOCOL_VERSION });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        sendJson(response, 200, {
          sessions: this.options.sessions.list(),
          pendingPermissions: this.options.permissions.listPending(),
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/hooks/codex") {
        const result = this.options.codex.adapt(await readJson(request, MAX_RAW_HOOK_BYTES));
        await this.handleAdapterResult("codex", result, request, response);
        return;
      }

      const copilotMatch = url.pathname.match(/^\/v1\/hooks\/copilot\/([a-zA-Z]+)$/);
      if (request.method === "POST" && copilotMatch?.[1]) {
        if (copilotMatch[1] === "permissionRequest") {
          request.resume();
          response.writeHead(204);
          response.end();
          return;
        }
        const result = this.options.copilot.adapt(
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
        const result = this.options.permissions.submitDecision(decision);
        const statusCode = result === "accepted" ? 200 : result === "not_found" ? 404 : 409;
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

    if (result.kind === "event") {
      const applied = this.options.sessions.apply(result.event);
      sendJson(response, 202, { result: applied.result });
      return;
    }

    if (this.options.permissions.isControllerAvailable()) this.options.sessions.apply(result.event);

    const controller = new AbortController();
    const abort = () => controller.abort();
    request.once("aborted", abort);
    response.once("close", () => {
      if (!response.writableEnded) abort();
    });
    const outcome = await this.options.permissions.waitForDecision(
      result.request,
      controller.signal,
    );
    this.sendPermissionOutcome(agent, outcome, response);
  }

  private sendPermissionOutcome(
    agent: "codex" | "copilot",
    outcome: PermissionOutcome,
    response: ServerResponse,
  ): void {
    if (response.destroyed) return;
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
    if (response.headersSent || response.destroyed) return;
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
    this.options.onError(safeError);
    sendJson(response, 500, { error: "internal_error" });
  }

  private isAuthorized(request: IncomingMessage): boolean {
    const provided = request.headers["x-vibemate-token"];
    const expected = this.options.getAuthToken();
    if (typeof provided !== "string" || !expected) return false;
    const expectedBuffer = Buffer.from(expected);
    const providedBuffer = Buffer.from(provided);
    return expectedBuffer.length === providedBuffer.length
      && timingSafeEqual(expectedBuffer, providedBuffer);
  }
}
