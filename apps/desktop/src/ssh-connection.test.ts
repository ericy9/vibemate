import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ssh2 from "ssh2";
import { createDefaultConfiguration, EnvironmentStore } from "./environment-store.js";
import { configureSshEnvironment } from "./ssh-environment-settings.js";
import { parseSshCredentials, parseSshDeviceInput, SshConnectionService } from "./ssh-connection.js";
import { sshFixture } from "./ssh-test-fixture.js";
const { utils } = ssh2;

test("manual input is bounded, supports IPv6, and rejects options and invalid endpoints", () => {
  const base = { name: "Pi", host: "192.168.1.50", port: 22, username: "pi", authentication: "password", password: "never persist me", hostFingerprint: "untrusted input" };
  const input = parseSshDeviceInput(base);
  assert.equal("password" in input, false); assert.equal("hostFingerprint" in input, false);
  assert.equal(parseSshDeviceInput({ ...base, host: "::1" }).host, "::1");
  for (const host of ["-oProxyCommand=bad", "pi@localhost", "localhost;id", "ssh://localhost", "a\0b"]) {
    assert.throws(() => parseSshDeviceInput({ ...base, host }));
  }
  for (const port of [0, 65_536, 22.5, "22"]) assert.throws(() => parseSshDeviceInput({ ...base, port }));
  assert.throws(() => parseSshDeviceInput({ ...base, username: "pi;id" }));
  assert.throws(() => parseSshDeviceInput({ ...base, authentication: "key" }));
  assert.deepEqual(parseSshCredentials({ password: "secret", passphrase: "", privateKey: "discard" }), { password: "secret" });
});

test("password testing confirms a real host key and probes without deploying or registering hooks", async t => {
  const fixture = await sshFixture(t);
  const identities: string[] = [];
  const service = new SshConnectionService(async identity => { identities.push(identity.fingerprint); return true; });
  t.after(() => service.clear());
  const checked = await service.test(fixture.input, { password: "test device password" });
  assert.deepEqual(identities, [fixture.fingerprint]);
  assert.equal(checked.hostname, "test-pi"); assert.equal(checked.architecture, "arm64");
  assert.deepEqual(checked.agents, { codex: false, copilot: true });
  assert.equal(fixture.commands.length, 1);
  assert.equal(fixture.commands[0]?.includes(".vibemate"), false);
  assert.equal(fixture.forwards.length, 0);
  assert.equal(JSON.stringify(checked).includes("test device password"), false);
});

test("wrong passwords, declined trust, and changed host keys cannot execute remote commands", async t => {
  const fixture = await sshFixture(t);
  const accepted = new SshConnectionService(async () => true); t.after(() => accepted.clear());
  await assert.rejects(() => accepted.test(fixture.input, { password: "wrong secret" }), /登录失败/);
  const declined = new SshConnectionService(async () => false); t.after(() => declined.clear());
  await assert.rejects(() => declined.test(fixture.input, { password: "test device password" }), /已取消/);
  let confirmations = 0;
  const pinned = new SshConnectionService(async () => { confirmations++; return true; }); t.after(() => pinned.clear());
  await assert.rejects(() => pinned.test(fixture.input, { password: "test device password" }, "SHA256:changed"), /身份已改变/);
  assert.equal(confirmations, 0); assert.equal(fixture.commands.length, 0);
});

test("verification is bound to the tested connection, single-use, and persistent settings exclude credentials", async t => {
  const fixture = await sshFixture(t);
  const service = new SshConnectionService(async () => true); t.after(() => service.clear());
  const checked = await service.test(fixture.input, { password: "test device password" });
  assert.throws(() => service.takeVerification(checked.verificationId, { ...fixture.input, username: "other" }), /已失效/);
  const verified = service.takeVerification(checked.verificationId, fixture.input);
  assert.throws(() => service.takeVerification(checked.verificationId, fixture.input), /已失效/);
  const configured = configureSshEnvironment(createDefaultConfiguration("PC"), fixture.input, verified.connection);
  const dir = await mkdtemp(join(tmpdir(), "vibemate-ssh-settings-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "environments.json");
  await new EnvironmentStore(path, "PC").save(configured.configuration);
  const text = await readFile(path, "utf8");
  for (const secret of ["test device password", "password\":", "passphrase", "authToken", "PRIVATE KEY"]) assert.equal(text.includes(secret), false);
  assert.equal(configured.environment.sshConnection?.hostFingerprint, fixture.fingerprint);
  service.remember(verified.connection, verified.credentials);
  const second = await service.test(fixture.input, {}, fixture.fingerprint);
  assert.ok(second.verificationId);
  service.clear();
  await assert.rejects(() => service.connect(verified.connection), /请输入设备登录密码/);
});

test("encrypted private keys authenticate with a transient passphrase and reject a wrong passphrase", async t => {
  const key = utils.generateKeyPairSync("ed25519", { cipher: "aes256-cbc", passphrase: "test key passphrase", rounds: 1 });
  const fixture = await sshFixture(t, { publicKey: key.public });
  const dir = await mkdtemp(join(tmpdir(), "vibemate-ssh-key-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "key"); await writeFile(path, key.private, { mode: 0o600 });
  const input = { ...fixture.input, authentication: "key" as const, privateKeyPath: path };
  const service = new SshConnectionService(async () => true); t.after(() => service.clear());
  await assert.rejects(() => service.test(input, { passphrase: "wrong" }), /密钥/);
  const checked = await service.test(input, { passphrase: "test key passphrase" });
  assert.equal(checked.hostname, "test-pi");
  const verified = service.takeVerification(checked.verificationId, input);
  const configured = configureSshEnvironment(createDefaultConfiguration("PC"), input, verified.connection);
  const persisted = JSON.stringify(configured.configuration);
  assert.equal(persisted.includes("test key passphrase"), false);
  assert.equal(persisted.includes("PRIVATE KEY"), false);
});

test("unsupported operating systems, architectures, and missing tar produce actionable failures", async t => {
  for (const [probe, message] of [
    ["os=Darwin\narch=arm64\ntar=yes\n", /仅支持 Linux/],
    ["os=Linux\narch=armv7l\ntar=yes\n", /架构暂不支持/],
    ["os=Linux\narch=x86_64\n", /缺少 tar/],
  ] as const) {
    const fixture = await sshFixture(t, { probe });
    const service = new SshConnectionService(async () => true); t.after(() => service.clear());
    await assert.rejects(() => service.test(fixture.input, { password: "test device password" }), message);
  }
});

test("editing settings preserves IDs and approvals, reuses endpoints, and drops pins after address changes", () => {
  const profile = parseSshDeviceInput({ name: "Pi", host: "192.168.1.50", port: 22, username: "pi", authentication: "password" });
  const first = configureSshEnvironment(createDefaultConfiguration("PC"), profile, { ...profile, hostFingerprint: "SHA256:known" });
  first.environment.codexApprovalsEnabled = true;
  const edited = configureSshEnvironment(first.configuration, { ...profile, name: "Renamed", authentication: "key", privateKeyPath: "/key" }, undefined, first.environment.environmentId);
  assert.equal(edited.environment.environmentId, first.environment.environmentId);
  assert.equal(edited.environment.codexApprovalsEnabled, true);
  assert.equal(edited.environment.sshConnection?.hostFingerprint, "SHA256:known");
  assert.equal(first.environment.name, "Pi");
  const changed = configureSshEnvironment(edited.configuration, { ...profile, host: "192.168.1.51" }, undefined, first.environment.environmentId);
  assert.equal(changed.environment.sshConnection?.hostFingerprint, undefined);
  const duplicate = configureSshEnvironment(first.configuration, { ...profile, name: "Same device" });
  assert.equal(duplicate.configuration.environments.length, first.configuration.environments.length);
});

test("forgetting a host invalidates verification tickets and requests fresh identity confirmation", async t => {
  const fixture = await sshFixture(t);
  let confirmations = 0;
  const service = new SshConnectionService(async () => { confirmations++; return true; }); t.after(() => service.clear());
  const first = await service.test(fixture.input, { password: "test device password" });
  service.forgetHost(fixture.input);
  assert.throws(() => service.takeVerification(first.verificationId, fixture.input), /已失效/);
  const second = await service.test(fixture.input, { password: "test device password" });
  assert.ok(second.verificationId); assert.equal(confirmations, 2);
});
