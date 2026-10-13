import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverSshHosts, parseWslList } from "./environment-discovery.js";

test("parseWslList distinguishes running and stopped distributions", () => {
  assert.deepEqual(parseWslList([
    "  NAME                   STATE           VERSION",
    "* Ubuntu-24.04          Running         2",
    "  Debian                 Stopped         2",
    "",
  ].join("\r\n")), [
    { name: "Ubuntu-24.04", running: true, version: 2 },
    { name: "Debian", running: false, version: 2 },
  ]);
});

test("discoverSshHosts returns concrete aliases only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibemate-ssh-config-"));
  const path = join(directory, "config");
  await writeFile(path, "Host pi lab-* !blocked\n  User robot\nHost devbox pi\n", "utf8");
  assert.deepEqual(await discoverSshHosts(path), ["pi", "devbox"]);
});
