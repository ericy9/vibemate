import { randomBytes } from "node:crypto";
import { VibeMateReceiver } from "./index.js";

const lanHost = process.env.VIBEMATE_LAN_HOST;
const managed = process.env.VIBEMATE_MANAGED === "1";
const lanPortValue = process.env.VIBEMATE_LAN_PORT;
let lanPort: number | undefined;
if (lanPortValue !== undefined) {
  const parsedPort = Number(lanPortValue);
  if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65_535) {
    throw new Error("VIBEMATE_LAN_PORT must be an integer from 0 to 65535");
  }
  lanPort = parsedPort;
}
const lanToken = process.env.VIBEMATE_LAN_TOKEN
  ?? (lanHost || managed ? randomBytes(32).toString("base64url") : undefined);
if (lanToken && lanToken.length < 32) {
  throw new Error("VIBEMATE_LAN_TOKEN must contain at least 32 characters");
}

const receiver = new VibeMateReceiver({
  codexApprovalsEnabled: !managed && process.env.VIBEMATE_CODEX_APPROVALS === "1",
  ...(process.env.VIBEMATE_RUNTIME_FILE ? { runtimeFilePath: process.env.VIBEMATE_RUNTIME_FILE } : {}),
  ...((lanHost || managed) && lanToken
    ? { lan: { host: lanHost ?? "127.0.0.1", ...(lanPort !== undefined ? { port: lanPort } : {}), authToken: lanToken } }
    : {}),
});
const address = await receiver.start();
console.log(`VibeMate receiver listening on http://${address.host}:${address.port}`);
const lanAddress = receiver.getLanAddress();
if (managed && lanAddress && lanToken) {
  process.stdout.write(`${JSON.stringify({
    type: "ready",
    protocolVersion: 1,
    host: lanAddress.host,
    port: lanAddress.port,
    authToken: lanToken,
  })}\n`);
} else if (lanAddress && lanToken) {
  console.log(`VibeMate LAN stream listening on ws://${lanAddress.host}:${lanAddress.port}/v1/stream`);
  console.log(`VibeMate LAN token: ${lanToken}`);
}

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  await receiver.stop();
}

if (managed) {
  process.stdin.setEncoding("utf8");
  let input = "";
  let eofTimer: NodeJS.Timeout | undefined;
  process.stdin.on("data", (chunk: string) => {
    input += chunk;
    for (;;) {
      const newline = input.indexOf("\n");
      if (newline < 0) break;
      const line = input.slice(0, newline).trim();
      input = input.slice(newline + 1);
      if (!line) continue;
      try {
        const message: unknown = JSON.parse(line);
        if (message && typeof message === "object" && "type" in message && message.type === "shutdown") {
          void stop().then(() => process.exit(0));
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : "invalid control message");
      }
    }
  });
  process.stdin.on("end", () => {
    eofTimer = setTimeout(() => void stop().then(() => process.exit(0)), 15_000);
    eofTimer.unref();
  });
  process.once("exit", () => {
    if (eofTimer) clearTimeout(eofTimer);
  });
  process.stdin.resume();
}

process.once("SIGINT", () => {
  void stop().then(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void stop().then(() => process.exit(0));
});
