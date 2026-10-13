import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { VibeMateReceiver } from "./index.js";

async function postJson(
  baseUrl: string,
  token: string,
  path: string,
  body: unknown,
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-vibemate-token": token,
    },
    body: JSON.stringify(body),
  });
}

test("receiver binds loopback, writes runtime discovery, and isolates sessions", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "vibemate-receiver-"));
  const runtimeFilePath = join(directory, "runtime.json");
  let id = 0;
  const receiver = new VibeMateReceiver({
    runtimeFilePath,
    adapterRuntime: {
      now: () => new Date("2026-08-13T12:00:00.000Z"),
      generateId: () => `id-${++id}`,
    },
  });
  context.after(() => receiver.stop());
  const address = await receiver.start();
  const baseUrl = `http://${address.host}:${address.port}`;

  assert.equal(address.host, "127.0.0.1");
  const runtime = JSON.parse(await readFile(runtimeFilePath, "utf8"));
  assert.equal(runtime.port, address.port);
  assert.equal(runtime.host, "127.0.0.1");
  assert.equal(typeof runtime.authToken, "string");

  assert.equal((await postJson(baseUrl, runtime.authToken, "/v1/hooks/codex", {
    hook_event_name: "UserPromptSubmit",
    session_id: "same-session",
  })).status, 202);
  assert.equal((await postJson(baseUrl, runtime.authToken, "/v1/hooks/copilot/userPromptSubmitted", {
    sessionId: "same-session",
  })).status, 202);

  assert.equal((await fetch(`${baseUrl}/v1/snapshot`)).status, 401);
  const snapshotResponse = await fetch(`${baseUrl}/v1/snapshot`, {
    headers: { "x-vibemate-token": runtime.authToken },
  });
  const snapshot = await snapshotResponse.json() as {
    sessions: unknown[];
  };
  assert.equal(snapshot.sessions.length, 2);
});

test("permission decision returns to the exact waiting Codex request", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "vibemate-permission-"));
  let id = 0;
  const receiver = new VibeMateReceiver({
    codexApprovalsEnabled: true,
    runtimeFilePath: join(directory, "runtime.json"),
    adapterRuntime: {
      now: () => new Date("2026-08-13T12:00:00.000Z"),
      generateId: () => `id-${++id}`,
    },
  });
  context.after(() => receiver.stop());
  const address = await receiver.start();
  const baseUrl = `http://${address.host}:${address.port}`;
  const runtime = JSON.parse(await readFile(join(directory, "runtime.json"), "utf8"));

  const hookResponsePromise = postJson(baseUrl, runtime.authToken, "/v1/hooks/codex", {
    hook_event_name: "PermissionRequest",
    session_id: "session-1",
    tool_name: "Bash",
    tool_input: {
      command: "npm test",
      description: "Run tests",
    },
  });

  let pending: {
    requestId: string;
    sourceProfile: string;
    agent: "codex";
    sessionId: string;
  } | undefined;
  for (let attempt = 0; attempt < 20 && !pending; attempt++) {
    const snapshot = await (await fetch(`${baseUrl}/v1/snapshot`, {
      headers: { "x-vibemate-token": runtime.authToken },
    })).json() as {
      pendingPermissions: typeof pending[];
    };
    pending = snapshot.pendingPermissions[0];
    if (!pending) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  assert.ok(pending);

  const decisionResponse = await postJson(
    baseUrl,
    runtime.authToken,
    `/v1/permissions/${pending.requestId}/decision`,
    {
      protocolVersion: 1,
      requestId: pending.requestId,
      sourceProfile: pending.sourceProfile,
      agent: pending.agent,
      sessionId: pending.sessionId,
      decision: "allow",
      decidedAt: "2026-08-13T12:00:01.000Z",
    },
  );
  assert.equal(decisionResponse.status, 200);

  const hookResponse = await hookResponsePromise;
  assert.equal(hookResponse.status, 200);
  assert.deepEqual(await hookResponse.json(), {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow" },
    },
  });
});

test("malformed Copilot permission request falls back without entering broker", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "vibemate-invalid-"));
  const receiver = new VibeMateReceiver({
    runtimeFilePath: join(directory, "runtime.json"),
  });
  context.after(() => receiver.stop());
  const address = await receiver.start();
  const baseUrl = `http://${address.host}:${address.port}`;
  const runtime = JSON.parse(await readFile(join(directory, "runtime.json"), "utf8"));

  const response = await postJson(
    baseUrl,
    runtime.authToken,
    "/v1/hooks/copilot/permissionRequest",
    {
    sessionId: "session-1",
    toolName: "edit",
    },
  );
  assert.equal(response.status, 204);

  const snapshot = await (await fetch(`${baseUrl}/v1/snapshot`, {
    headers: { "x-vibemate-token": runtime.authToken },
  })).json() as {
    pendingPermissions: unknown[];
  };
  assert.equal(snapshot.pendingPermissions.length, 0);
});

test("router maps malformed HTTP input without leaking internal errors", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "vibemate-http-errors-"));
  const receiver = new VibeMateReceiver({
    runtimeFilePath: join(directory, "runtime.json"),
  });
  context.after(() => receiver.stop());
  const address = await receiver.start();
  const baseUrl = `http://${address.host}:${address.port}`;
  const runtime = JSON.parse(await readFile(join(directory, "runtime.json"), "utf8"));
  const headers = { "x-vibemate-token": runtime.authToken };

  const unsupported = await fetch(`${baseUrl}/v1/hooks/codex`, {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(unsupported.status, 415);
  assert.deepEqual(await unsupported.json(), { error: "unsupported_media_type" });

  const malformed = await fetch(`${baseUrl}/v1/hooks/codex`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: "{",
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: "invalid_json" });
});

test("receiver can retry after a failed bind", async (context) => {
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const blockedAddress = blocker.address();
  assert.ok(blockedAddress && typeof blockedAddress !== "string");

  const directory = await mkdtemp(join(tmpdir(), "vibemate-bind-"));
  const receiver = new VibeMateReceiver({
    runtimeFilePath: join(directory, "runtime.json"),
  });
  context.after(() => receiver.stop());

  await assert.rejects(() => receiver.start(blockedAddress.port), /EADDRINUSE/);
  await new Promise<void>((resolve, reject) => blocker.close((error) => (
    error ? reject(error) : resolve()
  )));

  const address = await receiver.start();
  assert.equal(address.host, "127.0.0.1");
});

test("LAN stream pushes snapshots and returns permission decisions", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "vibemate-lan-"));
  let id = 0;
  const lanToken = "test-lan-token";
  const receiver = new VibeMateReceiver({
    runtimeFilePath: join(directory, "runtime.json"),
    lan: {
      host: "127.0.0.1",
      port: 0,
      authToken: lanToken,
    },
    adapterRuntime: {
      now: () => new Date("2026-08-13T12:00:00.000Z"),
      generateId: () => `id-${++id}`,
    },
  });
  context.after(() => receiver.stop());
  const address = await receiver.start();
  const lanAddress = receiver.getLanAddress();
  assert.ok(lanAddress);
  const runtime = JSON.parse(await readFile(join(directory, "runtime.json"), "utf8"));

  const webSocket = new WebSocket(
    `ws://${lanAddress.host}:${lanAddress.port}/v1/stream`,
    { headers: { Authorization: `Bearer ${lanToken}` } },
  );
  context.after(() => webSocket.close());
  await new Promise<void>((resolve, reject) => {
    webSocket.once("open", resolve);
    webSocket.once("error", reject);
  });
  const configured = new Promise<void>(resolve => {
    webSocket.on("message", data => { if (JSON.parse(data.toString()).commandId === "enable") resolve(); });
  });
  webSocket.send(JSON.stringify({ type: "set_codex_approvals", commandId: "enable", enabled: true }));
  await configured;

  const hookResponsePromise = postJson(
    `http://${address.host}:${address.port}`,
    runtime.authToken,
    "/v1/hooks/codex",
    {
      hook_event_name: "PermissionRequest",
      session_id: "remote-session",
      tool_name: "Bash",
      tool_input: {
        command: "npm test",
        description: "Run tests",
      },
    },
  );

  const pending = await new Promise<{
    requestId: string;
    sourceProfile: string;
    agent: "codex";
    sessionId: string;
  }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("snapshot timed out")), 2_000);
    webSocket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      const request = message.snapshot?.pendingPermissions?.[0];
      if (!request) return;
      clearTimeout(timeout);
      resolve(request);
    });
    webSocket.on("error", reject);
  });

  const resultPromise = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("decision result timed out")), 2_000);
    webSocket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type !== "permission_decision_result") return;
      clearTimeout(timeout);
      resolve(message.result);
    });
  });
  webSocket.send(JSON.stringify({
    type: "permission_decision",
    commandId: "command-1",
    decision: {
      protocolVersion: 1,
      requestId: pending.requestId,
      sourceProfile: pending.sourceProfile,
      agent: pending.agent,
      sessionId: pending.sessionId,
      decision: "allow",
      decidedAt: "2026-08-13T12:00:01.000Z",
    },
  }));

  assert.equal(await resultPromise, "accepted");
  const hookResponse = await hookResponsePromise;
  assert.equal(hookResponse.status, 200);
});
