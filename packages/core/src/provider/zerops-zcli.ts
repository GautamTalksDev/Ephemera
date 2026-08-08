import { spawn } from "node:child_process";

/** Never let a hung CLI block a reconciler tick. */
export const ZCLI_TIMEOUT_MS = 90_000;

export type ZcliResult = {
  stdout: string;
  stderr: string;
};

/**
 * Run `zcli` with a hard timeout; capture stdout+stderr into any error.
 */
export async function runZcli(
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ZcliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("zcli", args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (err: Error | undefined, result?: ZcliResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (err) {
        reject(err);
        return;
      }
      resolve(result!);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(
        new Error(
          `zcli ${args.join(" ")} timed out after ${ZCLI_TIMEOUT_MS}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    }, ZCLI_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      finish(
        new Error(
          `zcli ${args.join(" ")} failed to start: ${err.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    });
    child.on("close", (code) => {
      if (code === 0) {
        finish(undefined, { stdout, stderr });
        return;
      }
      finish(
        new Error(
          `zcli ${args.join(" ")} exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    });
  });
}

/** True when zcli reported the service is already gone (idempotent destroy). */
export function isZcliNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /not found/i.test(msg) || /service\s*\[[^\]]+\]\s*not found/i.test(msg);
}
