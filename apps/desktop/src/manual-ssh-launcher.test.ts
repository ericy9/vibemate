import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { VibeMateReceiver } from "@vibemate/receiver";
import WebSocket from "ws";
import { ManualSshLauncher } from "./manual-ssh-launcher.js";
import { configureSshEnvironment } from "./ssh-environment-settings.js";
import { createDefaultConfiguration } from "./environment-store.js";
import { SshConnectionService } from "./ssh-connection.js";
import { sshFixture } from "./ssh-test-fixture.js";

test("manual SSH deploys on demand, tunnels authenticated snapshots, and shuts down its receiver", { timeout: 15_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "vibemate-manual-launcher-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const authToken = "a".repeat(43);
  const receiver = new VibeMateReceiver({ runtimeFilePath: join(directory, "runtime.json"), lan: { host: "127.0.0.1", authToken } });
  const http = await receiver.start();
  t.after(() => receiver.stop());
  const remotePort = receiver.getLanAddress()!.port;
  let uploadBytes = 0;
  let installed = false;
  let shutdown = false;
  const fixture = await sshFixture(t, {
    command(command, channel) {
      if (command === "uname -m") { channel.write("x86_64\n"); channel.exit(0); channel.end(); }
      else if (command.includes("tar -xf")) {
        channel.on("data", (data: Buffer) => { uploadBytes += data.length; });
        channel.once("end", () => { channel.exit(0); channel.end(); });
      } else if (command.endsWith('cli.js" install')) {
        assert.ok(uploadBytes > 0); installed = true; channel.exit(0); channel.end();
      } else if (command.startsWith("exec env VIBEMATE_MANAGED=1")) {
        assert.equal(installed, true);
        channel.write(`${JSON.stringify({ type: "ready", protocolVersion: 1, host: "127.0.0.1", port: remotePort, authToken })}\n`);
        channel.on("data", (data: Buffer) => {
          if (data.toString().includes('"shutdown"')) { shutdown = true; channel.exit(0); channel.end(); }
        });
      } else { channel.exit(1); channel.end(); }
    },
    forward(channel, host, port) {
      assert.equal(host, "127.0.0.1"); assert.equal(port, remotePort);
      const socket = connect(port, host);
      socket.on("error", () => channel.destroy()); channel.on("error", () => socket.destroy());
      channel.once("close", () => socket.destroy()); socket.once("close", () => channel.destroy());
      channel.pipe(socket).pipe(channel);
    },
  });
  const service = new SshConnectionService(async () => true); t.after(() => service.clear());
  const tested = await service.test(fixture.input, { password: "test device password" });
  assert.equal(installed, false); assert.equal(uploadBytes, 0);
  const verified = service.takeVerification(tested.verificationId, fixture.input);
  const { environment } = configureSshEnvironment(createDefaultConfiguration("PC"), fixture.input, verified.connection);
  service.remember(verified.connection, verified.credentials);
  const payload = join(directory, "payload");
  await mkdir(join(payload, "x64", "runtime"), { recursive: true });
  await writeFile(join(payload, "x64", "runtime", "node"), "test payload");
  const endpoint = await new ManualSshLauncher(payload, service).start(environment);
  t.after(() => endpoint.stop());
  assert.equal(installed, true); assert.ok(uploadBytes > 0);
  assert.equal(new URL(endpoint.url).hostname, "127.0.0.1");
  const socket = new WebSocket(endpoint.url, { headers: { Authorization: `Bearer ${endpoint.authToken}` } });
  t.after(() => socket.terminate());
  const initial = once(socket, "message");
  await once(socket, "open");
  const [first] = await initial;
  assert.equal(JSON.parse(String(first)).type, "snapshot");
  const updated = once(socket, "message");
  const runtime = JSON.parse(await readFile(join(directory, "runtime.json"), "utf8"));
  const response = await fetch(`http://${http.host}:${http.port}/v1/hooks/copilot/userPromptSubmitted`, {
    method: "POST", headers: { "content-type": "application/json", "x-vibemate-token": runtime.authToken },
    body: JSON.stringify({ sessionId: "ssh-copilot", timestamp: Date.now() }),
  });
  assert.equal(response.status, 202);
  const [data] = await updated;
  assert.equal(JSON.parse(String(data)).snapshot.sessions[0].sessionId, "ssh-copilot");
  assert.ok(fixture.forwards.length > 0);
  await endpoint.stop();
  assert.equal(shutdown, true);
  await endpoint.stop();
});

test("missing payload fails before deployment and closes the SSH connection", async t => {
  const fixture = await sshFixture(t, {
    command(command, channel) {
      assert.equal(command, "uname -m"); channel.write("x86_64\n"); channel.exit(0); channel.end();
    },
  });
  const service = new SshConnectionService(async () => true); t.after(() => service.clear());
  const checked = await service.test(fixture.input, { password: "test device password" });
  const verified = service.takeVerification(checked.verificationId, fixture.input);
  const { environment } = configureSshEnvironment(createDefaultConfiguration("PC"), fixture.input, verified.connection);
  service.remember(verified.connection, verified.credentials);
  await assert.rejects(() => new ManualSshLauncher(undefined, service).start(environment), /缺少设备运行时/);
  assert.equal(fixture.commands.some(command => command.includes("tar -xf")), false);
});
