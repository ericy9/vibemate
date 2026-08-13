import { VibeMateReceiver } from "./index.js";

const receiver = new VibeMateReceiver();
const address = await receiver.start();
console.log(`VibeMate receiver listening on http://${address.host}:${address.port}`);

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  await receiver.stop();
}

process.once("SIGINT", () => {
  void stop().then(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void stop().then(() => process.exit(0));
});
