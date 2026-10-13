import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { nativeFallback, parseRuntimeConfig, runHook } from "./index.js";

const TOKEN = "a".repeat(43);

interface TestServer {
  port: number;
  close(): Promise<void>;
  request(): Promise<{
    url: string;
    token: string | undefined;
    body: string;
  }>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function startServer(
  respond: (request: IncomingMessage, response: ServerResponse, body: string) => void,
): Promise<TestServer> {
  let resolveRequest: ((value: {
    url: string;
    token: string | undefined;
    body: string;
  }) => void) | undefined;
  const requestPromise = new Promise<{
    url: string;
    token: string | undefined;
    body: string;
  }>((resolve) => {
    resolveRequest = resolve;
  });
  const server = createServer((request, response) => {
    void readBody(request).then((body) => {
      resolveRequest?.({
        url: request.url ?? "",
        token: typeof request.headers["x-vibemate-token"] === "string"
          ? request.headers["x-vibemate-token"]
          : undefined,
        body,
      });
      respond(request, response, body);
      if (!response.writableEnded) {
        response.writeHead(500);
        response.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    ))),
    request: () => requestPromise,
  };
}

async function writeRuntime(port: number): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vibemate-hook-runner-"));
  const path = join(directory, "runtime.json");
  await writeFile(path, JSON.stringify({
    protocolVersion: 1,
    host: "127.0.0.1",
    port,
    pid: process.pid,
    startedAt: "2026-08-13T12:00:00.000Z",
    authToken: TOKEN,
  }));
  await chmod(path, 0o600);
  return path;
}

async function runCli(
  cliPath: string,
  args: string[],
  input: string,
  runtimePath: string,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const child = spawn(process.execPath, [cliPath, ...args], {
    env: { ...process.env, VIBEMATE_RUNTIME_PATH: runtimePath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end(input);
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return {
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
    exitCode,
  };
}

test("Codex lifecycle hooks use authenticated loopback delivery", async (context) => {
  const server = await startServer((_request, response) => {
    response.writeHead(202);
    response.end("{}");
  });
  context.after(() => server.close());
  const runtimeFilePath = await writeRuntime(server.port);
  const input = JSON.stringify({
    hook_event_name: "SessionStart",
    session_id: "session-1",
  });

  const result = await runHook({ agent: "codex", input, runtimeFilePath });
  assert.deepEqual(result, { stdout: "{}", delivered: true, permission: false });
  assert.deepEqual(await server.request(), {
    url: "/v1/hooks/codex",
    token: TOKEN,
    body: input,
  });
});

test("Copilot lifecycle hooks include the event name in the route", async (context) => {
  const server = await startServer((_request, response) => {
    response.writeHead(202);
    response.end("{}");
  });
  context.after(() => server.close());
  const runtimeFilePath = await writeRuntime(server.port);
  const input = JSON.stringify({ sessionId: "session-2" });

  const result = await runHook({
    agent: "copilot",
    eventName: "sessionStart",
    input,
    runtimeFilePath,
  });
  assert.deepEqual(result, { stdout: "", delivered: true, permission: false });
  assert.deepEqual(await server.request(), {
    url: "/v1/hooks/copilot/sessionStart",
    token: TOKEN,
    body: input,
  });
});

test("permission output is canonicalized before reaching the agent", async (context) => {
  const server = await startServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied in VibeMate"}}}',
    );
  });
  context.after(() => server.close());
  const runtimeFilePath = await writeRuntime(server.port);

  const result = await runHook({
    agent: "codex",
    input: JSON.stringify({
      hook_event_name: "PermissionRequest",
      session_id: "session-3",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    }),
    runtimeFilePath,
  });
  assert.equal(result.stdout, JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "deny",
        message: "Denied in VibeMate",
      },
    },
  }));
});

test("legacy Copilot permission hooks bypass runtime and transport entirely", async () => {
  const result = await runHook({
    agent: "copilot",
    eventName: "permissionRequest",
    input: JSON.stringify({
      sessionId: "session-4",
      toolName: "shell",
      toolInput: {},
    }),
    runtimeFilePath: "/nonexistent/vibemate-runtime.json",
    fetchImpl: async () => { throw new Error("transport must not be used"); },
  });
  assert.deepEqual(result, { stdout: "", delivered: false, permission: true });
  assert.equal(nativeFallback("copilot"), "");
});

test("runtime discovery is constrained to private loopback configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibemate-hook-invalid-"));
  const runtimeFilePath = join(directory, "runtime.json");
  await writeFile(runtimeFilePath, JSON.stringify({
    protocolVersion: 1,
    host: "192.0.2.1",
    port: 12345,
    pid: process.pid,
    startedAt: "2026-08-13T12:00:00.000Z",
    authToken: TOKEN,
  }));
  await chmod(runtimeFilePath, 0o600);

  await assert.rejects(() => runHook({
    agent: "codex",
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "session-5",
    }),
    runtimeFilePath,
  }), /runtime config is invalid/);
});

test("runtime discovery contract accepts the receiver-owned shape", () => {
  const runtime = parseRuntimeConfig({
    protocolVersion: 1,
    host: "127.0.0.1",
    port: 43123,
    pid: 1234,
    startedAt: "2026-08-13T12:00:00.000Z",
    authToken: TOKEN,
  });

  assert.deepEqual(runtime, {
    protocolVersion: 1,
    host: "127.0.0.1",
    port: 43123,
    pid: 1234,
    startedAt: "2026-08-13T12:00:00.000Z",
    authToken: TOKEN,
  });
  assert.throws(() => parseRuntimeConfig({ ...runtime, protocolVersion: 2 }), /invalid/);
  assert.throws(() => parseRuntimeConfig({ ...runtime, authToken: "short" }), /invalid/);
});

test("CLI exits successfully with native fallback when the receiver is absent", async () => {
  const missingRuntime = join(
    tmpdir(),
    `missing-vibemate-runtime-${process.pid}-${Date.now()}.json`,
  );
  const cliPath = join(import.meta.dirname, "cli.js");
  const codex = await runCli(
    cliPath,
    ["codex"],
    JSON.stringify({
      hook_event_name: "PermissionRequest",
      session_id: "session-6",
      tool_name: "Bash",
      tool_input: {},
    }),
    missingRuntime,
  );
  const copilot = await runCli(
    cliPath,
    ["copilot", "permissionRequest"],
    JSON.stringify({
        sessionId: "session-7",
        toolName: "shell",
        toolInput: {},
    }),
    missingRuntime,
  );

  assert.equal(codex.exitCode, 0);
  assert.equal(codex.stdout, "{}");
  assert.equal(codex.stderr, "");
  assert.equal(copilot.exitCode, 0);
  assert.equal(copilot.stdout, "");
  assert.equal(copilot.stderr, "");
});
