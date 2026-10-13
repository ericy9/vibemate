import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { TestContext } from "node:test";
import ssh2, { type Connection, type ServerChannel } from "ssh2";
import type { SshDeviceInput } from "./environment-types.js";
const { Server, utils } = ssh2;

export async function sshFixture(t: TestContext, options: {
  probe?: string;
  publicKey?: string;
  command?: (command: string, channel: ServerChannel) => void;
  forward?: (channel: ServerChannel, host: string, port: number) => void;
} = {}) {
  const key = utils.generateKeyPairSync("ed25519");
  const hostKey = utils.parseKey(key.private);
  assert.ok(!(hostKey instanceof Error));
  const authorized = options.publicKey ? utils.parseKey(options.publicKey) : undefined;
  assert.ok(!(authorized instanceof Error));
  const clients = new Set<Connection>();
  const commands: string[] = [];
  const forwards: Array<{ host: string; port: number }> = [];
  const server = new Server({ hostKeys: [key.private] }, client => {
    clients.add(client); client.on("error", () => undefined); client.once("close", () => clients.delete(client));
    client.on("authentication", context => {
      if (context.username === "pi") {
        if (context.method === "password" && context.password === "test device password") { context.accept(); return; }
        if (context.method === "publickey" && authorized && context.key.data.equals(authorized.getPublicSSH())
          && (!context.signature || (context.blob && authorized.verify(context.blob, context.signature, context.hashAlgo) === true))) {
          context.accept(); return;
        }
      }
      context.reject(["password", "publickey"]);
    });
    client.on("session", accept => {
      const session = accept();
      session.on("exec", (acceptCommand, _reject, info) => {
        commands.push(info.command);
        const channel = acceptCommand(); channel.on("error", () => undefined);
        if (info.command.includes("printf 'os='")) {
          channel.write(options.probe ?? "os=Linux\narch=aarch64\nhostname=test-pi\ntar=yes\ncopilot=yes\n");
          channel.exit(0); channel.end();
        } else if (options.command) options.command(info.command, channel);
        else { channel.exit(1); channel.end(); }
      });
    });
    client.on("tcpip", (accept, reject, info) => {
      forwards.push({ host: info.destIP, port: info.destPort });
      if (options.forward) options.forward(accept(), info.destIP, info.destPort);
      else reject();
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(async () => {
    for (const client of clients) client.end();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const input: SshDeviceInput = { name: "Test Pi", host: "127.0.0.1", port: address.port, username: "pi", authentication: "password" };
  return {
    input, commands, forwards,
    fingerprint: `SHA256:${createHash("sha256").update(hostKey.getPublicSSH()).digest("base64").replace(/=+$/, "")}`,
  };
}
