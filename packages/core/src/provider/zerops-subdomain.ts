import { lookup as dnsLookup } from "node:dns/promises";

/** Wait budget for an enable-subdomain process (and idle/ACTIVE gate). */
export const SUBDOMAIN_POLL_MS = 180_000;
export const SUBDOMAIN_ENABLE_ATTEMPTS = 3;
const POLL_INTERVAL_MS = 3_000;

const PROCESS_DONE = new Set([
  "FINISHED",
  "FAILED",
  "CANCELED",
  "CANCELLED",
]);
const PROCESS_BUSY = new Set(["PENDING", "RUNNING"]);

export type ZeropsProcess = {
  id: string;
  status: string;
  actionName?: string;
  serviceStackId?: string;
  appVersion?: { id?: string; status?: string } | null;
};

export type SubdomainLogFn = (entry: {
  level: "info" | "error";
  step: string;
  message: string;
}) => void | Promise<void>;

export function publicUrlForHostname(
  hostname: string,
  subdomainHost: string,
  port: number | undefined,
): string {
  if (port !== undefined && port > 0) {
    return `https://${hostname}-${subdomainHost}-${port}.prg1.zerops.app`;
  }
  return `https://${hostname}-${subdomainHost}.prg1.zerops.app`;
}

export async function hostnameResolvable(
  hostname: string,
  lookupImpl: typeof dnsLookup = dnsLookup,
): Promise<boolean> {
  try {
    await lookupImpl(hostname);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number, sleepImpl?: (ms: number) => Promise<void>): Promise<void> {
  if (sleepImpl) {
    return sleepImpl(ms);
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isProcessBusy(status: string | undefined): boolean {
  return PROCESS_BUSY.has((status ?? "").toUpperCase());
}

export function isProcessDone(status: string | undefined): boolean {
  return PROCESS_DONE.has((status ?? "").toUpperCase());
}

export function isEnableSubdomainAction(actionName: string | undefined): boolean {
  return (actionName ?? "").toLowerCase().includes("enablesubdomain");
}

export function isBuildAction(actionName: string | undefined): boolean {
  const a = (actionName ?? "").toLowerCase();
  return (
    a.includes("stack.build") ||
    a === "build" ||
    a.includes("build_and_deploy")
  );
}

/**
 * Poll GET /process/:id until FINISHED/FAILED or timeout.
 */
export async function waitForZeropsProcess(
  processId: string,
  options: {
    apiGet: <T>(path: string) => Promise<T>;
    timeoutMs?: number;
    intervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    onLog?: SubdomainLogFn;
    step?: string;
  },
): Promise<ZeropsProcess> {
  const timeoutMs = options.timeoutMs ?? SUBDOMAIN_POLL_MS;
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  const step = options.step ?? "subdomain";

  while (now() < deadline) {
    const proc = await options.apiGet<ZeropsProcess>(`/process/${processId}`);
    if (isProcessDone(proc.status)) {
      if ((proc.status ?? "").toUpperCase() === "FINISHED") {
        await options.onLog?.({
          level: "info",
          step,
          message: `process ${processId} finished (${proc.actionName ?? "unknown"})`,
        });
        return proc;
      }
      throw new Error(
        `Zerops process ${processId} ended with status ${proc.status}` +
          (proc.actionName ? ` (${proc.actionName})` : ""),
      );
    }
    await sleep(intervalMs, options.sleep);
  }
  throw new Error(
    `Zerops process ${processId} did not finish within ${Math.round(timeoutMs / 1000)}s`,
  );
}

/**
 * Wait until the service is ACTIVE and has no PENDING/RUNNING processes.
 */
export async function waitForServiceIdleAndActive(options: {
  serviceId: string;
  serviceName: string;
  getStack: () => Promise<{ id: string; name: string; status?: string } | undefined>;
  listProcesses: () => Promise<ZeropsProcess[]>;
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onLog?: SubdomainLogFn;
}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? SUBDOMAIN_POLL_MS;
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;

  await options.onLog?.({
    level: "info",
    step: "subdomain",
    message: `${options.serviceName}: waiting until ACTIVE with no busy processes before enable-subdomain`,
  });

  while (now() < deadline) {
    const stack = await options.getStack();
    const status = (stack?.status ?? "").toUpperCase();
    const procs = await options.listProcesses();
    const busy = procs.filter((p) => isProcessBusy(p.status));
    if (status === "ACTIVE" && busy.length === 0) {
      await options.onLog?.({
        level: "info",
        step: "subdomain",
        message: `${options.serviceName}: idle and ACTIVE — safe to enable-subdomain`,
      });
      return;
    }
    const busySummary = busy
      .map((p) => `${p.actionName ?? "process"}:${p.status}`)
      .join(", ");
    await options.onLog?.({
      level: "info",
      step: "subdomain",
      message: `${options.serviceName}: not ready for enable (status=${stack?.status ?? "missing"}; busy=${busySummary || "none"})`,
    });
    await sleep(intervalMs, options.sleep);
  }
  throw new Error(
    `${options.serviceName}: still not ACTIVE/idle after ${Math.round(timeoutMs / 1000)}s — refusing enable-subdomain`,
  );
}

export type EnsureSubdomainResult =
  | { ok: true; publicUrl: string }
  | { ok: false; message: string };

async function waitOutEnableProcess(
  proc: ZeropsProcess,
  options: {
    serviceName: string;
    apiGet: <T>(path: string) => Promise<T>;
    pollMs: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    onLog?: SubdomainLogFn;
  },
): Promise<void> {
  await options.onLog?.({
    level: "info",
    step: "subdomain",
    message: `${options.serviceName}: enable already ${proc.status} (process ${proc.id}) — waiting, not re-queuing`,
  });
  await waitForZeropsProcess(proc.id, {
    apiGet: options.apiGet,
    timeoutMs: options.pollMs,
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
  });
}

/**
 * Enable subdomain access for one service stack.
 * Gate on ACTIVE+idle, never stack enable calls while one is PENDING, 180s process wait.
 */
export async function ensureServiceSubdomainAccess(options: {
  serviceId: string;
  serviceName: string;
  subdomainHost: string;
  port?: number;
  apiGet: <T>(path: string) => Promise<T>;
  apiPut: <T>(path: string, body?: unknown) => Promise<T>;
  getStack: () => Promise<{
    id: string;
    name: string;
    status?: string;
    subdomainAccess?: boolean;
    ports?: Array<{ port?: number; httpPort?: number }>;
  } | undefined>;
  listProcesses: () => Promise<ZeropsProcess[]>;
  onLog?: SubdomainLogFn;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  lookup?: typeof dnsLookup;
  pollMs?: number;
  attempts?: number;
}): Promise<EnsureSubdomainResult> {
  const pollMs = options.pollMs ?? SUBDOMAIN_POLL_MS;
  const maxPuts = options.attempts ?? SUBDOMAIN_ENABLE_ATTEMPTS;
  const now = options.now ?? Date.now;
  const publicUrl = publicUrlForHostname(
    options.serviceName,
    options.subdomainHost,
    options.port,
  );
  const urlHost = new URL(publicUrl).hostname;

  const checkReady = async (): Promise<boolean> => {
    const stack = await options.getStack();
    if (!stack?.subdomainAccess) {
      return false;
    }
    return hostnameResolvable(urlHost, options.lookup);
  };

  if (await checkReady()) {
    await options.onLog?.({
      level: "info",
      step: "subdomain",
      message: `${options.serviceName}: subdomain already enabled (${publicUrl})`,
    });
    return { ok: true, publicUrl };
  }

  let lastMessage = `${options.serviceName}: subdomain not enabled`;
  let puts = 0;
  // Bound total loop iterations (pending-enable waits do not increment `puts`).
  const maxRounds = maxPuts * 4;

  for (let round = 0; round < maxRounds && puts < maxPuts; round += 1) {
    if (await checkReady()) {
      return { ok: true, publicUrl };
    }

    // Never stack enable calls: if one is already PENDING/RUNNING, wait for it.
    const pendingEnable = (await options.listProcesses()).find(
      (p) => isEnableSubdomainAction(p.actionName) && isProcessBusy(p.status),
    );
    if (pendingEnable) {
      try {
        await waitOutEnableProcess(pendingEnable, {
          serviceName: options.serviceName,
          apiGet: options.apiGet,
          pollMs,
          ...(options.sleep ? { sleep: options.sleep } : {}),
          ...(options.now ? { now: options.now } : {}),
          ...(options.onLog ? { onLog: options.onLog } : {}),
        });
      } catch (err) {
        lastMessage =
          err instanceof Error
            ? `${options.serviceName}: pending enable failed: ${err.message}`
            : `${options.serviceName}: pending enable failed: ${String(err)}`;
        await options.onLog?.({
          level: "error",
          step: "subdomain",
          message: lastMessage,
        });
      }
      if (await checkReady()) {
        await options.onLog?.({
          level: "info",
          step: "subdomain",
          message: `${options.serviceName}: subdomain enabled and URL resolvable (${publicUrl})`,
        });
        return { ok: true, publicUrl };
      }
      // Enable finished but not ready yet — fall through to readiness poll / retry.
    } else {
      // No enable in flight: wait until ACTIVE and no other busy processes, then PUT.
      try {
        await waitForServiceIdleAndActive({
          serviceId: options.serviceId,
          serviceName: options.serviceName,
          getStack: options.getStack,
          listProcesses: options.listProcesses,
          timeoutMs: pollMs,
          ...(options.sleep ? { sleep: options.sleep } : {}),
          ...(options.now ? { now: options.now } : {}),
          ...(options.onLog ? { onLog: options.onLog } : {}),
        });
      } catch (err) {
        lastMessage = err instanceof Error ? err.message : String(err);
        await options.onLog?.({
          level: "error",
          step: "subdomain",
          message: lastMessage,
        });
        return { ok: false, message: lastMessage };
      }

      // Re-check: a concurrent enable may have appeared while we waited for idle.
      const raced = (await options.listProcesses()).find(
        (p) => isEnableSubdomainAction(p.actionName) && isProcessBusy(p.status),
      );
      if (raced) {
        continue;
      }

      puts += 1;
      await options.onLog?.({
        level: "info",
        step: "subdomain",
        message: `${options.serviceName}: enable-subdomain attempt ${puts}/${maxPuts}`,
      });

      try {
        const proc = await options.apiPut<ZeropsProcess>(
          `/service-stack/${options.serviceId}/enable-subdomain-access`,
        );
        if (proc?.id) {
          await options.onLog?.({
            level: "info",
            step: "subdomain",
            message: `${options.serviceName}: queued process ${proc.id} (status=${proc.status ?? "unknown"})`,
          });
          if (!isProcessDone(proc.status)) {
            await waitForZeropsProcess(proc.id, {
              apiGet: options.apiGet,
              timeoutMs: pollMs,
              ...(options.sleep ? { sleep: options.sleep } : {}),
              ...(options.now ? { now: options.now } : {}),
              ...(options.onLog ? { onLog: options.onLog } : {}),
            });
          }
        }
      } catch (err) {
        lastMessage =
          err instanceof Error
            ? `${options.serviceName}: enable call failed: ${err.message}`
            : `${options.serviceName}: enable call failed: ${String(err)}`;
        await options.onLog?.({
          level: "error",
          step: "subdomain",
          message: lastMessage,
        });
      }
    }

    const deadline = now() + Math.min(pollMs, 60_000);
    while (now() < deadline) {
      if (await checkReady()) {
        await options.onLog?.({
          level: "info",
          step: "subdomain",
          message: `${options.serviceName}: subdomain enabled and URL resolvable (${publicUrl})`,
        });
        return { ok: true, publicUrl };
      }
      const stillPending = (await options.listProcesses()).find(
        (p) => isEnableSubdomainAction(p.actionName) && isProcessBusy(p.status),
      );
      if (stillPending) {
        try {
          await waitOutEnableProcess(stillPending, {
            serviceName: options.serviceName,
            apiGet: options.apiGet,
            pollMs,
            ...(options.sleep ? { sleep: options.sleep } : {}),
            ...(options.now ? { now: options.now } : {}),
            ...(options.onLog ? { onLog: options.onLog } : {}),
          });
        } catch {
          /* next loop / put */
        }
        continue;
      }
      await sleep(POLL_INTERVAL_MS, options.sleep);
    }

    lastMessage = `${options.serviceName}: subdomain still not enabled/resolvable (puts=${puts}/${maxPuts})`;
    await options.onLog?.({
      level: "error",
      step: "subdomain",
      message: lastMessage,
    });
  }

  return {
    ok: false,
    message:
      lastMessage ||
      `${options.serviceName}: subdomain not enabled after ${maxRounds} rounds`,
  };
}
