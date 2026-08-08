/**
 * Gate: two processes call claimNextEnvironment() concurrently and must
 * receive different environment rows (SELECT … FOR UPDATE SKIP LOCKED).
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";

function runClaimer(label: string): Promise<{
  label: string;
  id: string | null;
  actualState?: string;
  prNumber?: number;
}> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "pnpm",
      [
        "exec",
        "tsx",
        resolve(import.meta.dirname, "claim-one.ts"),
        label,
      ],
      {
        cwd: resolve(import.meta.dirname, ".."),
        env: {
          ...process.env,
          // Hold the row lock so the sibling process overlaps and must SKIP LOCKED.
          CLAIM_LOCK_HOLD_MS: process.env.CLAIM_LOCK_HOLD_MS ?? "1000",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `${label} exited ${code}\nstdout: ${stdout}\nstderr: ${stderr}`,
          ),
        );
        return;
      }
      const line = stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .at(-1);
      if (!line) {
        reject(new Error(`${label} produced no output`));
        return;
      }
      resolvePromise(JSON.parse(line) as {
        label: string;
        id: string | null;
        actualState?: string;
        prNumber?: number;
      });
    });
  });
}

const [a, b] = await Promise.all([runClaimer("A"), runClaimer("B")]);

console.log("A:", a);
console.log("B:", b);

if (!a.id || !b.id) {
  throw new Error("expected both processes to claim a row (seed has claimable envs)");
}
if (a.id === b.id) {
  throw new Error(`both processes claimed the same environment ${a.id}`);
}

console.log("\nGate OK: concurrent claimNextEnvironment() returned different rows.");
