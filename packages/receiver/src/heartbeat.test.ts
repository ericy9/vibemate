import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { VibeMateReceiver } from "./index.js";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "vibemate-heartbeat-"));
  const receiver = new VibeMateReceiver({
    runtimeFilePath: join(directory, "runtime.json"),
    lan: { host: "127.0.0.1", authToken: "heartbeat-test", heartbeatIntervalMs: 30, heartbeatTimeoutMs: 240 },
  });
  t.after(async () => { await receiver.stop(); await rm(directory, { recursive: true, force: true }); });
  const address = await receiver.start();
  const lan = receiver.getLanAddress()!;
  const runtime = JSON.parse(await readFile(join(directory, "runtime.json"), "utf8"));
  let session = 0;
  return {
    receiver,
    async connect(autoPong = true, approvals = true) {
      const socket = new WebSocket(`ws://${lan.host}:${lan.port}/v1/stream`, {
        headers: { Authorization: "Bearer heartbeat-test" }, autoPong,
      });
      t.after(() => socket.terminate());
      await once(socket, "open");
      await configure(socket, approvals);
      return socket;
    },
    post(agent: "codex" | "copilot", lifecycle = false) {
      return fetch(`http://${address.host}:${address.port}/v1/hooks/${agent}${agent === "copilot" ? "/permissionRequest" : ""}`, {
        method: "POST", signal: AbortSignal.timeout(2_000),
        headers: { "content-type": "application/json", "x-vibemate-token": runtime.authToken },
        body: JSON.stringify(agent === "codex" ? {
          hook_event_name: lifecycle ? "UserPromptSubmit" : "PermissionRequest",
          session_id: `session-${++session}`, tool_name: "Bash", tool_input: { command: "npm test" },
        } : { sessionId: `session-${++session}`, toolName: "shell", toolArgs: { command: "npm test" } }),
      });
    },
  };
}

async function configure(socket: WebSocket, enabled: boolean) {
  const commandId = `configure-${enabled}`;
  const result = new Promise<void>(resolve => {
    const handler = (data: WebSocket.RawData) => {
      if (JSON.parse(data.toString()).commandId !== commandId) return;
      socket.off("message", handler); resolve();
    };
    socket.on("message", handler);
  });
  socket.send(JSON.stringify({ type: "set_codex_approvals", commandId, enabled }));
  await result;
}

async function waitPending(receiver: VibeMateReceiver) {
  for (let i = 0; i < 100; i++) {
    const request = receiver.permissions.listPending()[0];
    if (request) return request;
    await delay(5);
  }
  throw new Error("permission did not become pending");
}

test("without a desktop both agents fall back immediately while lifecycle events continue", { timeout: 4_000 }, async t => {
  const f = await fixture(t);
  assert.deepEqual(await (await f.post("codex")).json(), {});
  assert.equal((await f.post("copilot")).status, 204);
  assert.equal(f.receiver.permissions.listPending().length, 0);
  assert.equal((await f.post("codex", true)).status, 202);
});

test("desktop close releases pending approvals and reconnection cannot revive old decisions", { timeout: 4_000 }, async t => {
  const f = await fixture(t);
  const socket = await f.connect();
  const response = f.post("codex");
  const pending = await waitPending(f.receiver);
  socket.close();
  assert.deepEqual(await (await response).json(), {});
  assert.equal(f.receiver.permissions.listPending().length, 0);
  await f.connect();
  assert.equal(f.receiver.permissions.submitDecision({ ...pending, decision: "allow", decidedAt: new Date().toISOString() }), "already_finalized");
  const next = f.post("codex");
  const nextRequest = await waitPending(f.receiver);
  assert.equal(f.receiver.permissions.submitDecision({ ...nextRequest, decision: "allow", decidedAt: new Date().toISOString() }), "accepted");
  assert.notDeepEqual(await (await next).json(), {});
});

test("silent desktop stops answering pings: pending and subsequent requests fall back", { timeout: 4_000 }, async t => {
  const f = await fixture(t);
  const socket = await f.connect(false);
  const response = f.post("codex");
  await waitPending(f.receiver);
  const closed = once(socket, "close");
  assert.deepEqual(await (await response).json(), {});
  await closed;
  assert.equal(f.receiver.permissions.listPending().length, 0);
  assert.deepEqual(await (await f.post("codex")).json(), {});
});

test("healthy pongs keep approvals alive beyond the lease and one lost client does not stop another", { timeout: 4_000 }, async t => {
  const f = await fixture(t);
  const first = await f.connect();
  const second = await f.connect();
  const response = f.post("codex");
  const pending = await waitPending(f.receiver);
  first.close();
  await delay(550);
  assert.equal(second.readyState, WebSocket.OPEN);
  assert.equal(f.receiver.permissions.listPending()[0]?.requestId, pending.requestId);
  second.close();
  assert.deepEqual(await (await response).json(), {});
});

test("monitor-only desktop never blocks; opt-in affects only Codex and opt-out releases requests", { timeout: 4_000 }, async t => {
  const f = await fixture(t);
  const socket = await f.connect(true, false);
  assert.deepEqual(await (await f.post("codex")).json(), {});
  assert.equal(f.receiver.sessions.list().length, 0);
  await configure(socket, true);
  assert.equal((await f.post("copilot")).status, 204);
  assert.equal(f.receiver.permissions.listPending().length, 0);
  const waiting = f.post("codex");
  await waitPending(f.receiver);
  await configure(socket, false);
  assert.deepEqual(await (await waiting).json(), {});
  assert.deepEqual(await (await f.post("codex")).json(), {});
});
