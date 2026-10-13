import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { VibeMateReceiver } from "./index.js";

test("Copilot notifications update state without creating approvals or retaining notification text", async context => {
  const directory = await mkdtemp(join(tmpdir(), "vibemate-notification-"));
  const runtimeFilePath = join(directory, "runtime.json");
  const receiver = new VibeMateReceiver({ runtimeFilePath });
  context.after(async () => { await receiver.stop(); await rm(directory, { recursive: true, force: true }); });
  const address = await receiver.start();
  const runtime = JSON.parse(await readFile(runtimeFilePath, "utf8"));
  async function notify(sessionId: string, notification_type: string) {
    return fetch(`http://${address.host}:${address.port}/v1/hooks/copilot/notification`, {
      method: "POST", headers: { "content-type": "application/json", "x-vibemate-token": runtime.authToken },
      body: JSON.stringify({ sessionId, timestamp: Date.now(), cwd: "/project", notification_type, message: "private command details" }),
    });
  }
  assert.equal((await notify("notice", "permission_prompt")).status, 202);
  assert.equal(receiver.sessions.list()[0]?.state, "waiting_permission");
  assert.equal(receiver.sessions.list()[0]?.recentEvents[0]?.event, "permission_prompt");
  assert.equal(receiver.permissions.listPending().length, 0);
  assert.equal(JSON.stringify(receiver.sessions.list()).includes("private command details"), false);
  await notify("irrelevant", "shell_completed");
  assert.equal(receiver.sessions.list().length, 1);
});
