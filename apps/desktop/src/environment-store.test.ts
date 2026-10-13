import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EnvironmentStore } from "./environment-store.js";
import type { EnvironmentConfig } from "./environment-types.js";

test("environment settings persist without transport secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibemate-environments-"));
  const path = join(directory, "environments.json");
  const store = new EnvironmentStore(path, "Test PC");
  const configuration = await store.load();
  assert.equal(configuration.environments[0]?.kind, "windows");
  assert.equal(configuration.environments[0]?.enabled, false);
  await store.save(configuration);
  const text = await readFile(path, "utf8");
  assert.equal(text.includes("authToken"), false);
  assert.equal(text.includes("ws://"), false);
  assert.deepEqual(await store.load(), configuration);
  delete configuration.environments[0]!.codexApprovalsEnabled;
  await store.save(configuration);
  assert.equal((await store.load()).environments[0]?.codexApprovalsEnabled, false);
  configuration.environments[0]!.codexApprovalsEnabled = true;
  await store.save(configuration);
  assert.equal((await store.load()).environments[0]?.codexApprovalsEnabled, true);
});

test("mergeDiscovered deduplicates WSL distributions and SSH aliases", () => {
  const existing: EnvironmentConfig[] = [{ environmentId: "1", deviceId: "d", name: "Ubuntu", kind: "wsl", enabled: true, distribution: "Ubuntu" }];
  const discovered: EnvironmentConfig[] = [
    { environmentId: "2", deviceId: "d", name: "ubuntu", kind: "wsl", enabled: false, distribution: "ubuntu" },
    { environmentId: "3", deviceId: "r", name: "pi", kind: "ssh", enabled: false, sshHost: "pi" },
  ];
  assert.deepEqual(EnvironmentStore.mergeDiscovered(existing, discovered).map((item) => item.environmentId), ["1", "3"]);
});

test("older settings default both desktop surfaces to visible", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibemate-environments-"));
  const path = join(directory, "environments.json");
  await writeFile(path, JSON.stringify({
    version: 1,
    devices: [],
    environments: [],
    preferences: { focus: { kind: "all" } },
    onboardingCompleted: true,
  }));

  const configuration = await new EnvironmentStore(path, "Test PC").load();
  assert.equal(configuration.preferences.showPet, true);
  assert.equal(configuration.preferences.showPreview, true);
});
