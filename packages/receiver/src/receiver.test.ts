import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
  assert.equal(response.status, 422);

  const snapshot = await (await fetch(`${baseUrl}/v1/snapshot`, {
    headers: { "x-vibemate-token": runtime.authToken },
  })).json() as {
    pendingPermissions: unknown[];
  };
  assert.equal(snapshot.pendingPermissions.length, 0);
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
