import { VERSION } from "@ephemera/core";
import { startWorker } from "./worker.js";

console.log("worker up");
console.log(`@ephemera/core ${VERSION}`);

const handles = await startWorker();
console.log("reconciler listening on queue 'reconcile' (+ 10s scan, 60s reaper)");

async function shutdown(signal: string) {
  console.log(`worker shutting down (${signal})`);
  await handles.stop();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
