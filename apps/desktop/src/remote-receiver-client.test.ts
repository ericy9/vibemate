import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { VibeMateReceiver } from "@vibemate/receiver";
import { RemoteReceiverClient } from "./remote-receiver-client.js";

test("remote receiver client connects and receives snapshots", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "vibemate-remote-client-"));
  const lanToken = "test-token-with-at-least-thirty-two-characters";
  const receiver = new VibeMateReceiver({
    runtimeFilePath: join(directory, "runtime.json"),
    lan: { host: "127.0.0.1", port: 0, authToken: lanToken },
  });
  context.after(() => receiver.stop());
  const address = await receiver.start();
  const lanAddress = receiver.getLanAddress();
  assert.ok(lanAddress);

  const client = new RemoteReceiverClient({
    url: `ws://${lanAddress.host}:${lanAddress.port}/v1/stream`,
    authToken: lanToken,
  });
  context.after(() => client.stop());
  client.start();

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("remote client timed out")), 2_000);
    const unsubscribe = client.subscribe(() => {
      if (client.getStatus() === "connected") {
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      }
    });
  });

  const runtime = JSON.parse(await readFile(join(directory, "runtime.json"), "utf8"));
  const response = await fetch(
    `http://${address.host}:${address.port}/v1/hooks/codex`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vibemate-token": runtime.authToken,
      },
      body: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "remote-client-session",
      }),
    },
  );
  assert.equal(response.status, 202);

  if (client.getSnapshot().sessions.length !== 1) {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("snapshot update timed out")), 2_000);
      const unsubscribe = client.subscribe(() => {
        if (client.getSnapshot().sessions.length === 1) {
          clearTimeout(timeout);
          unsubscribe();
          resolve();
        }
      });
    });
  }
  assert.equal(client.getSnapshot().sessions[0]?.sessionId, "remote-client-session");
  assert.equal(receiver.permissions.isControllerAvailable(), false);
  await client.setCodexApprovals(true);
  assert.equal(receiver.permissions.isControllerAvailable(), true);
  await client.setCodexApprovals(false);
  assert.equal(receiver.permissions.isControllerAvailable(), false);
  client.stop();
  await client.setCodexApprovals(true);
  client.start();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("reconnect configuration timed out")), 2_000);
    const unsubscribe = client.subscribe(() => {
      if (client.getStatus() !== "connected") return;
      clearTimeout(timeout); unsubscribe(); resolve();
    });
  });
  assert.equal(receiver.permissions.isControllerAvailable(), true);
});
