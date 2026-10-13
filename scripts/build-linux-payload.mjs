import { execFile } from "node:child_process";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const outputRoot = join(root, "build", "linux-payload");
const nodeVersion = process.env.VIBEMATE_NODE_VERSION ?? "v22.18.0";
const architectures = { x64: "x64", arm64: "arm64" };

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function downloadNode(architecture, output) {
  const archiveName = `node-${nodeVersion}-linux-${architecture}.tar.xz`;
  const archive = join(outputRoot, archiveName);
  if (!await exists(archive)) {
    const response = await fetch(`https://nodejs.org/dist/${nodeVersion}/${archiveName}`);
    if (!response.ok) throw new Error(`Node runtime download failed: ${response.status}`);
    await writeFile(archive, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
  }
  const extract = join(outputRoot, `.node-${architecture}`);
  await rm(extract, { recursive: true, force: true });
  await mkdir(extract, { recursive: true });
  await execFileAsync("tar", ["-xJf", archive, "-C", extract, "--strip-components=2", `node-${nodeVersion}-linux-${architecture}/bin/node`]);
  await mkdir(join(output, "runtime"), { recursive: true });
  await rename(join(extract, "node"), join(output, "runtime", "node"));
  await rm(extract, { recursive: true, force: true });
}

async function bundle(output) {
  await mkdir(join(output, "app"), { recursive: true });
  await writeFile(join(output, "app", "package.json"), '{"type":"module"}\n', "utf8");
  const entries = [
    ["packages/receiver/src/cli.ts", "app/receiver/dist/cli.js"],
    ["packages/hook-runner/src/cli.ts", "app/hook-runner/dist/cli.js"],
    ["packages/hook-installer/src/cli.ts", "app/hook-installer/dist/cli.js"],
  ];
  for (const [entry, destination] of entries) {
    await build({
      entryPoints: [join(root, entry)], outfile: join(output, destination), bundle: true,
      platform: "node", format: "esm", target: "node22", sourcemap: false,
      banner: { js: "#!/usr/bin/env node\nimport { createRequire as __vibemateCreateRequire } from 'node:module'; const require = __vibemateCreateRequire(import.meta.url);" },
    });
  }
}

await mkdir(outputRoot, { recursive: true });
for (const [directory, nodeArchitecture] of Object.entries(architectures)) {
  const output = join(outputRoot, directory);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await Promise.all([bundle(output), downloadNode(nodeArchitecture, output)]);
}
