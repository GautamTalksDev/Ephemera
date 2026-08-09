import { execFile } from "node:child_process";

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
 * Run `zcli` via execFile with an argument array (never a shell string / exec).
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
  // Copy into a mutable string[] — execFile must never receive a shell string.
  const argv = [...args];

  return new Promise((resolve, reject) => {
    execFile(
      "zcli",
      argv,
      {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        // shell defaults to false for execFile — do not set shell: true.
      },
      (err, stdout, stderr) => {
        const out = String(stdout ?? "");
        const errOut = String(stderr ?? "");
        if (!err) {
          resolve({ stdout: out, stderr: errOut });
          return;
        }

        const e = err as NodeJS.ErrnoException & {
          killed?: boolean;
          signal?: NodeJS.Signals | null;
          code?: string | number | null;
        };

        if (e.killed || e.signal === "SIGTERM" || e.signal === "SIGKILL") {
          reject(
            new Error(
              `zcli ${argv.join(" ")} timed out after ${timeoutMs}ms\nstdout:\n${out}\nstderr:\n${errOut}`,
            ),
          );
          return;
        }

        if (typeof e.code === "string") {
          // spawn/execFile start failures (ENOENT, EACCES, …)
          reject(
            new Error(
              `zcli ${argv.join(" ")} failed to start: ${e.message}\nstdout:\n${out}\nstderr:\n${errOut}`,
            ),
          );
          return;
        }

        reject(
          new Error(
            `zcli ${argv.join(" ")} exited ${e.code}\nstdout:\n${out}\nstderr:\n${errOut}`,
          ),
        );
      },
    );
  });
}

/** True when zcli reported the service is already gone (idempotent destroy). */
export function isZcliNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /not found/i.test(msg) || /service\s*\[[^\]]+\]\s*not found/i.test(msg);
}
