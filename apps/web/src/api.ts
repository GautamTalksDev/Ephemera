export type EnvironmentItem = {
  id: string;
  repoFullName: string;
  prNumber: number;
  branch: string;
  headSha: string;
  desiredState: string;
  actualState: string;
  publicUrl: string | null;
  errorMessage: string | null;
  degraded: boolean;
  providerRef: string | null;
  attemptCount: number;
  expiresAt: string;
  lastReconciledAt: string | null;
  createdAt: string;
  updatedAt: string;
  waitingOn: string;
};

export type EnvironmentEvent = {
  id: string;
  level: "info" | "error";
  step: string;
  message: string;
  createdAt: string;
};

/**
 * Dev: Vite proxies `/api/*` → api (stripping the prefix).
 * Prod: set `VITE_API_BASE` to the public api origin (no trailing slash).
 */
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(
  /\/$/,
  "",
) ?? "";

/** In-memory only — never persisted (localStorage unsupported here). */
let adminToken = "";

export function setAdminToken(token: string): void {
  adminToken = token.trim();
}

export function getAdminToken(): string {
  return adminToken;
}

function apiUrl(path: string): string {
  if (API_BASE) {
    // Production: talk to api host directly (paths have no /api prefix).
    return `${API_BASE}${path}`;
  }
  return `/api${path}`;
}

function authHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  if (adminToken) {
    headers.set("Authorization", `Bearer ${adminToken}`);
  }
  return headers;
}

async function mutate(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = authHeaders(init.headers);
  return fetch(apiUrl(path), { ...init, headers });
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchEnvironments(): Promise<EnvironmentItem[]> {
  const data = await json<{ environments: EnvironmentItem[] }>(
    await fetch(apiUrl("/environments")),
  );
  return data.environments;
}

export async function fetchEnvironmentDetail(id: string): Promise<{
  environment: EnvironmentItem;
  events: EnvironmentEvent[];
}> {
  return json(await fetch(apiUrl(`/environments/${id}`)));
}

export async function destroyEnvironment(id: string): Promise<void> {
  await json(
    await mutate(`/environments/${id}/destroy`, { method: "POST" }),
  );
}

export async function retryEnvironment(id: string): Promise<void> {
  await json(await mutate(`/environments/${id}/retry`, { method: "POST" }));
}

export async function extendEnvironmentTtl(
  id: string,
  minutes?: number,
): Promise<EnvironmentItem> {
  const data = await json<{ environment: EnvironmentItem }>(
    await mutate(`/environments/${id}/ttl`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        minutes !== undefined ? { minutes } : {},
      ),
    }),
  );
  return data.environment;
}

export async function runLiveDemo(): Promise<{ environmentId: string }> {
  return json(await mutate("/demo/run", { method: "POST" }));
}

export async function importComposeYaml(compose: string): Promise<{
  previewYml: string;
  warnings: string[];
}> {
  return json(
    await mutate("/import/compose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ compose }),
    }),
  );
}

export function ttlLabel(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (Number.isNaN(ms)) {
    return "—";
  }
  if (ms <= 0) {
    return "expired";
  }
  const mins = Math.ceil(ms / 60_000);
  if (mins < 60) {
    return `${mins}m`;
  }
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h${m ? ` ${m}m` : ""}`;
}
