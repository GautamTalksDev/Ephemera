import { spawn } from "node:child_process";

/** Default for login / misc zcli calls. */
export const ZCLI_TIMEOUT_MS = 120_000;
export const ZCLI_IMPORT_TIMEOUT_MS = 300_000;
/** Build + artefact upload + "Deploying service" often exceeds 2 minutes. */
export const ZCLI_PUSH_TIMEOUT_MS = 420_000;
export const ZCLI_DELETE_TIMEOUT_MS = 120_000;

export type ZcliResult = {
  stdout: string;
  stderr: string;
};

export function timeoutForZcliArgs(args: readonly string[]): number {
  if (args[0] === "project" && args[1] === "service-import") {
    return ZCLI_IMPORT_TIMEOUT_MS;
  }
  if (args[0] === "service" && args[1] === "push") {
    return ZCLI_PUSH_TIMEOUT_MS;
  }
  if (args[0] === "service" && args[1] === "delete") {
    return ZCLI_DELETE_TIMEOUT_MS;
  }
  return ZCLI_TIMEOUT_MS;
}

/**
 * Run `zcli` with a hard timeout; capture stdout+stderr into any error.
 * service-import: 300s; push: 420s; delete/other: 120s.
 */
export async function runZcli(
  args: readonly string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  } = {},
): Promise<ZcliResult> {
  const timeoutMs = options.timeoutMs ?? timeoutForZcliArgs(args);

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
          `zcli ${args.join(" ")} timed out after ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    }, timeoutMs);

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
