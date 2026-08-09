import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { stringify as yamlStringify } from "yaml";
import {
  ENV_REF_RE,
  SERVICE_NAME_RE,
  type PreviewSpec,
  type Service,
} from "../preview/schema.js";
import { isZcliNotFoundError, runZcli, ZCLI_TIMEOUT_MS } from "./zerops-zcli.js";
import type {
  CreateEnvironmentInput,
  CreateEnvironmentResult,
  DeployCodeInput,
  DestroyEnvironmentInput,
  GetStatusInput,
  GetStatusPhase,
  GetStatusResult,
  Provider,
  ProviderStatusState,
} from "./types.js";

const ZEROPS_API_BASE = "https://api.app-prg1.zerops.io/api/rest/public";
const HOSTNAME_MAX = 25;

/** Smallest vertical autoscaling profile for runtimes/static (shared CPU, 1 GB disk). */
const SMALLEST_VERTICAL = {
  cpuMode: "SHARED",
  minCpu: 1,
  maxCpu: 1,
  minRam: 0.25,
  maxRam: 0.25,
  minDisk: 1,
  maxDisk: 1,
} as const;

/**
 * Databases need a higher disk floor than runtimes/static.
 * Zerops rejects postgresql stack.create with minDisk/maxDisk of 1
 * (Internal Server Error); 5 GB is the verified platform minimum.
 */
const DATABASE_VERTICAL = {
  cpuMode: "SHARED",
  minCpu: 1,
  maxCpu: 1,
  minRam: 0.25,
  maxRam: 0.25,
  minDisk: 5,
  maxDisk: 5,
} as const;

type ZeropsServiceStack = {
  id: string;
  name: string;
  status: string;
  base?: string | null;
  subdomainAccess?: boolean;
  ports?: Array<{ port?: number; httpPort?: number }>;
  activeAppVersion?: { status?: string } | null;
  isSystem?: boolean;
};

type ZeropsProject = {
  id: string;
  zeropsSubdomainHost?: string | null;
};

function requireEnv(...names: string[]): string {
  for (const name of names) {
    const v = process.env[name]?.trim();
    if (v) {
      return v;
    }
  }
  throw new Error(
    `${names.join(" or ")} is required when PROVIDER=zerops`,
  );
}

/** Deterministic hostname prefix for a PR — also used as providerRef. */
export function providerRefForPr(prNumber: number): string {
  if (!Number.isInteger(prNumber) || prNumber < 1) {
    throw new Error(`prNumber must be a positive integer, got ${prNumber}`);
  }
  return `pr${prNumber}`;
}

/**
 * Service hostnames: `pr{prNumber}{serviceName}` — max 25 chars, deterministic.
 * Service names must already match SERVICE_NAME_RE (no sanitising here).
 */
export function serviceHostname(prNumber: number, serviceName: string): string {
  if (!SERVICE_NAME_RE.test(serviceName)) {
    throw new Error(
      `service name ${JSON.stringify(serviceName)} must match ${SERVICE_NAME_RE}`,
    );
  }
  const prefix = providerRefForPr(prNumber);
  return `${prefix}${serviceName}`.slice(0, HOSTNAME_MAX);
}

function prNumberFromProviderRef(providerRef: string): number {
  const m = /^pr(\d+)$/.exec(providerRef);
  if (!m) {
    throw new Error(
      `ZeropsProvider: providerRef must look like pr{N}, got "${providerRef}"`,
    );
  }
  return Number(m[1]);
}

function hostnameMatchesPrefix(name: string, prefix: string): boolean {
  return name === prefix || name.startsWith(prefix);
}

type ImportService = Record<string, unknown>;

/**
 * Translate PreviewSpec → Zerops project service-import YAML services[].
 *
 * Note: runtime (nodejs) on LIGHT projects rejects `mode: NON_HA` /
 * `mode: HA` (`serviceStackTypeNotFound`). We omit `mode` for runtimes and
 * keep NON_HA for databases/static where the API accepts it. Databases also
 * reject minContainers/maxContainers.
 */
export function buildImportServices(
  prNumber: number,
  spec: PreviewSpec,
): ImportService[] {
  return spec.services.map((svc) => {
    const hostname = serviceHostname(prNumber, svc.name);

    if (svc.type === "runtime") {
      return {
        hostname,
        verticalAutoscaling: { ...SMALLEST_VERTICAL },
        type: svc.runtime,
        // LIGHT projects: do not set mode (NON_HA/HA are unavailable for nodejs).
        minContainers: 1,
        maxContainers: 1,
        enableSubdomainAccess: svc.public,
      };
    }

    if (svc.type === "database") {
      return {
        hostname,
        verticalAutoscaling: { ...DATABASE_VERTICAL },
        type: svc.engine,
        mode: "NON_HA",
        priority: 10,
      };
    }

    // static
    return {
      hostname,
      verticalAutoscaling: { ...SMALLEST_VERTICAL },
      type: "static",
      mode: "NON_HA",
      minContainers: 1,
      maxContainers: 1,
      enableSubdomainAccess: svc.public,
    };
  });
}

/**
 * Map preview.yml env keys to Zerops-generated shared env names.
 * Postgres exposes `connectionString`; 1 GB-disk mistakes aside, this is the
 * usual footgun for `${db.DATABASE_URL}`.
 */
export function mapZeropsSharedEnvVar(varName: string): string {
  const upper = varName.toUpperCase();
  if (
    upper === "DATABASE_URL" ||
    upper === "CONNECTION_STRING" ||
    varName === "connectionString"
  ) {
    return "connectionString";
  }
  return varName;
}

/**
 * Translate `${serviceName.VAR}` → `${hostname_zeropsVar}` using the PR-prefixed
 * hostname (e.g. `${db.DATABASE_URL}` at PR 1 → `${pr1db_connectionString}`).
 */
export function translateEnvRefsToZerops(
  value: string,
  prNumber: number,
  serviceNames: ReadonlySet<string>,
): string {
  return value.replace(ENV_REF_RE, (match, serviceName: string, varName: string) => {
    if (!serviceNames.has(serviceName)) {
      throw new Error(
        `env reference ${match} points at unknown service "${serviceName}"; ` +
          `known services: ${[...serviceNames].sort().join(", ") || "(none)"}`,
      );
    }
    const hostname = serviceHostname(prNumber, serviceName);
    const zeropsVar = mapZeropsSharedEnvVar(varName);
    return `\${${hostname}_${zeropsVar}}`;
  });
}

export function translateServiceEnv(
  env: Record<string, string>,
  prNumber: number,
  serviceNames: ReadonlySet<string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = translateEnvRefsToZerops(value, prNumber, serviceNames);
  }
  return out;
}

/** Fail fast if preview.yml references a service name that isn't in the spec. */
export function assertEnvRefsValid(spec: PreviewSpec): void {
  const names = new Set(spec.services.map((s) => s.name));
  for (const svc of spec.services) {
    for (const [key, value] of Object.entries(svc.env)) {
      ENV_REF_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = ENV_REF_RE.exec(value)) !== null) {
        const refService = match[1];
        const refVar = match[2];
        if (!refService || !refVar) {
          continue;
        }
        if (!names.has(refService)) {
          throw new Error(
            `service "${svc.name}" env ${key}: reference \${${refService}.${refVar}} ` +
              `points at unknown service "${refService}" (not in preview.yml). ` +
              `Known services: ${[...names].sort().join(", ")}`,
          );
        }
      }
    }
  }
}

function buildZeropsYamlForService(
  hostname: string,
  svc: Service,
  prNumber: number,
  serviceNames: ReadonlySet<string>,
): Record<string, unknown> {
  if (svc.type === "database") {
    throw new Error(`cannot build zerops.yaml for database service ${svc.name}`);
  }

  const envVariables =
    Object.keys(svc.env).length > 0
      ? translateServiceEnv(svc.env, prNumber, serviceNames)
      : undefined;

  if (svc.type === "runtime") {
    const run: Record<string, unknown> = {
      base: svc.runtime,
      start: svc.start,
      ports: [{ port: svc.port, httpSupport: true }],
    };
    if (envVariables) {
      run.envVariables = envVariables;
    }
    return {
      zerops: [
        {
          setup: hostname,
          build: {
            base: svc.runtime,
            buildCommands: svc.build.commands,
            deployFiles: "./",
          },
          run,
        },
      ],
    };
  }

  // static — Zerops static runtime serves built files
  const run: Record<string, unknown> = {
    base: "static",
    ports: [{ port: svc.port, httpSupport: true }],
  };
  if (envVariables) {
    run.envVariables = envVariables;
  }
  return {
    zerops: [
      {
        setup: hostname,
        build: {
          base: "static",
          buildCommands: svc.build.commands,
          deployFiles: "./",
        },
        run,
      },
    ],
  };
}

const PUBLIC_URL_PROBE_TIMEOUT_MS = 10_000;

/** GET public URL; ready only on non-5xx (connection errors / 5xx → keep waiting). */
export async function probePublicUrl(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; message?: string }> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PUBLIC_URL_PROBE_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, {
        method: "GET",
        redirect: "follow",
        signal: ctrl.signal,
        headers: { Accept: "*/*" },
      });
      if (res.status >= 500) {
        return {
          ok: false,
          message: `public URL ${url} returned ${res.status}`,
        };
      }
      return { ok: true };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `public URL ${url} not reachable yet: ${msg}`,
    };
  }
}

/**
 * Embed a GitHub installation token in an https://github.com remote.
 * Non-GitHub / non-https URLs (including local paths) are returned unchanged.
 */
export function withGitHubInstallationToken(
  repoUrl: string,
  token: string | undefined,
): string {
  if (!token) {
    return repoUrl;
  }
  try {
    const u = new URL(repoUrl);
    if (u.protocol !== "https:") {
      return repoUrl;
    }
    if (u.hostname !== "github.com" && u.hostname !== "www.github.com") {
      return repoUrl;
    }
    u.username = "x-access-token";
    u.password = token;
    return u.toString();
  } catch {
    return repoUrl;
  }
}

/** Strip tokens from git/command output before logging or writing events. */
export function redactGitSecrets(
  text: string,
  secrets: readonly string[] = [],
): string {
  let out = text.replace(/x-access-token:[^@\s]+@/gi, "x-access-token:***@");
  for (const secret of secrets) {
    if (secret.length === 0) {
      continue;
    }
    out = out.split(secret).join("***");
  }
  return out;
}

async function runGit(
  args: readonly string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    secrets?: readonly string[];
  } = {},
): Promise<void> {
  const secrets = options.secrets ?? [];
  const safeArgs = () => redactGitSecrets(args.join(" "), secrets);
  const safeText = (text: string) => redactGitSecrets(text, secrets);

  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `git ${safeArgs()} timed out after ${ZCLI_TIMEOUT_MS}ms\nstdout:\n${safeText(stdout)}\nstderr:\n${safeText(stderr)}`,
        ),
      );
    }, ZCLI_TIMEOUT_MS);
    child.stdout.on("data", (c: Buffer | string) => {
      stdout += String(c);
    });
    child.stderr.on("data", (c: Buffer | string) => {
      stderr += String(c);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new Error(safeText(err instanceof Error ? err.message : String(err))),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `git ${safeArgs()} exited ${code}\nstdout:\n${safeText(stdout)}\nstderr:\n${safeText(stderr)}`,
        ),
      );
    });
  });
}

/**
 * Shallow-fetch an arbitrary commit (or branch/tag) into `repoDir`.
 * `--branch` cannot take a SHA; init/fetch/checkout FETCH_HEAD can.
 */
export async function checkoutGitRef(options: {
  repoDir: string;
  repoUrl: string;
  ref: string;
  installationToken?: string;
}): Promise<void> {
  const secrets = options.installationToken
    ? [options.installationToken]
    : [];
  const remoteUrl = withGitHubInstallationToken(
    options.repoUrl,
    options.installationToken,
  );

  await mkdir(options.repoDir, { recursive: true });
  await runGit(["init"], { cwd: options.repoDir, secrets });
  await runGit(["remote", "add", "origin", remoteUrl], {
    cwd: options.repoDir,
    secrets,
  });
  await runGit(["fetch", "--depth", "1", "origin", options.ref], {
    cwd: options.repoDir,
    secrets,
  });
  await runGit(["checkout", "FETCH_HEAD"], {
    cwd: options.repoDir,
    secrets,
  });
}

/** Managed data stores (Postgres, Valkey, …) — never READY_TO_DEPLOY. */
export function isDatabaseStack(svc: {
  base?: string | null;
  name: string;
}): boolean {
  const b = (svc.base ?? "").toLowerCase();
  return /postgresql|mariadb|mysql|valkey|redis|keydb|mongodb|elastic/.test(b);
}

const PROVISIONING_STATUSES = new Set([
  "NEW",
  "CREATING",
  "DEPLOYING",
  "STARTING",
  "RESTARTING",
]);

/**
 * Map a single Zerops service-stack status into our provider state.
 * Unrecognised values wait (provisioning) and are logged so we can extend the map.
 */
export function mapZeropsServiceStatus(
  status: string,
  phase: GetStatusPhase,
): ProviderStatusState {
  const s = status.toUpperCase();

  if (PROVISIONING_STATUSES.has(s)) {
    return "provisioning";
  }
  if (s === "READY_TO_DEPLOY") {
    // Stack exists and awaits code push — success for provision, wait for deploy.
    return phase === "provisioned" ? "ready" : "provisioning";
  }
  if (s === "ACTIVE") {
    return "ready";
  }
  if (s.includes("FAIL") || s.includes("ERROR")) {
    return "failed";
  }

  console.warn(
    `[zerops] unrecognised service status ${JSON.stringify(status)}; treating as provisioning`,
  );
  return "provisioning";
}

/**
 * Phase-aware readiness over a Zerops service-stack list.
 * Exported for unit tests with mocked list responses.
 */
export function evaluateZeropsStatus(
  services: ZeropsServiceStack[],
  project: ZeropsProject,
  phase: GetStatusPhase,
): GetStatusResult {
  if (services.length === 0) {
    return {
      state: "failed",
      message: "no services found",
    };
  }

  const summary = () => services.map((s) => `${s.name}:${s.status}`).join(", ");
  const mapped = services.map((s) => ({
    svc: s,
    state: mapZeropsServiceStatus(s.status, phase),
  }));

  const failed = mapped.filter((m) => m.state === "failed");
  if (failed.length > 0) {
    return {
      state: "failed",
      message: failed.map((m) => `${m.svc.name}:${m.svc.status}`).join(", "),
    };
  }

  const allReady = mapped.every((m) => m.state === "ready");
  if (!allReady) {
    return { state: "provisioning", message: summary() };
  }

  if (phase === "provisioned") {
    return { state: "ready", message: summary() };
  }

  // phase === "deployed" — publicUrl is required; never report ready without one.
  const subdomainHost = project.zeropsSubdomainHost ?? undefined;
  const publicSvc =
    services.find((s) => s.subdomainAccess) ??
    services.find((s) => (s.ports?.length ?? 0) > 0);

  let publicUrl: string | undefined;
  if (publicSvc && subdomainHost) {
    const port =
      publicSvc.ports?.[0]?.port ??
      publicSvc.ports?.[0]?.httpPort ??
      undefined;
    publicUrl = publicUrlFor(publicSvc.name, subdomainHost, port);
  }

  if (!publicUrl) {
    return {
      state: "provisioning",
      message: `${summary()} (waiting for public subdomain)`,
    };
  }

  return {
    state: "ready",
    message: summary(),
    publicUrl,
  };
}

function publicUrlFor(
  hostname: string,
  subdomainHost: string,
  port: number | undefined,
): string {
  // https://{hostname}-{zeropsSubdomainHost}-{port}.prg1.zerops.app
  if (port !== undefined && port > 0) {
    return `https://${hostname}-${subdomainHost}-${port}.prg1.zerops.app`;
  }
  return `https://${hostname}-${subdomainHost}.prg1.zerops.app`;
}

export class ZeropsProvider implements Provider {
  readonly name = "zerops";

  private readonly token: string;
  private readonly projectId: string;
  private loginReady: Promise<void> | undefined;

  constructor(
    options: { token?: string; projectId?: string } = {},
  ) {
    // Zerops forbids custom env keys with a ZEROPS_ prefix on its own platform,
    // so the control-plane worker uses EPHEMERA_PREVIEW_* there. Local/dev still
    // uses ZEROPS_API_TOKEN / ZEROPS_PROJECT_ID.
    this.token =
      options.token ??
      requireEnv("ZEROPS_API_TOKEN", "EPHEMERA_PREVIEW_TOKEN");
    this.projectId =
      options.projectId ??
      requireEnv("ZEROPS_PROJECT_ID", "EPHEMERA_PREVIEW_PROJECT_ID");
  }

  private async ensureLogin(): Promise<void> {
    if (!this.loginReady) {
      this.loginReady = runZcli(["login", this.token]).then(() => undefined);
    }
    await this.loginReady;
  }

  private async apiGet<T>(path: string): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ZCLI_TIMEOUT_MS);
    try {
      const res = await fetch(`${ZEROPS_API_BASE}${path}`, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
        },
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(
          `Zerops API GET ${path} → ${res.status}\n${text.slice(0, 2000)}`,
        );
      }
      return JSON.parse(text) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private async listServiceStacks(): Promise<ZeropsServiceStack[]> {
    const body = await this.apiGet<{ list: ZeropsServiceStack[] }>(
      `/project/${this.projectId}/service-stack`,
    );
    return body.list ?? [];
  }

  private async getProject(): Promise<ZeropsProject> {
    return this.apiGet<ZeropsProject>(`/project/${this.projectId}`);
  }

  private async servicesForRef(providerRef: string): Promise<ZeropsServiceStack[]> {
    const all = await this.listServiceStacks();
    return all.filter(
      (s) => !s.isSystem && hostnameMatchesPrefix(s.name, providerRef),
    );
  }

  async createEnvironment(
    input: CreateEnvironmentInput,
  ): Promise<CreateEnvironmentResult> {
    const prNumber = input.prNumber;
    if (prNumber === undefined) {
      throw new Error(
        "ZeropsProvider.createEnvironment requires prNumber (hostname prefix)",
      );
    }
    // Catch bad ${service.VAR} refs before import — otherwise the app boots
    // with a literal/garbage hostname like "base" from an untranslated URL.
    assertEnvRefsValid(input.spec);
    const providerRef = providerRefForPr(prNumber);
    const desired = buildImportServices(prNumber, input.spec);
    const existing = await this.listServiceStacks();
    const existingNames = new Set(existing.map((s) => s.name));

    // BEFORE creating, skip any hostnames that already exist (idempotent).
    const toCreate = desired.filter(
      (svc) => !existingNames.has(String(svc.hostname)),
    );

    if (toCreate.length === 0) {
      return { providerRef };
    }

    await this.ensureLogin();

    const importDoc = { services: toCreate };
    const dir = await mkdtemp(join(tmpdir(), "ephemera-zerops-import-"));
    const yamlPath = join(dir, "import.yml");
    try {
      await writeFile(yamlPath, yamlStringify(importDoc), "utf8");
      // Shell out to zcli rather than the REST import API: the CLI already
      // handles YAML validation, process queuing, and waits for stack.create
      // — fewer auth/payload edge cases than re-implementing import over HTTP.
      await runZcli([
        "project",
        "service-import",
        yamlPath,
        "-P",
        this.projectId,
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    return { providerRef };
  }

  async deployCode(input: DeployCodeInput): Promise<void> {
    const prNumber = prNumberFromProviderRef(input.providerRef);
    const deployable = input.spec.services.filter(
      (s) => s.type === "runtime" || s.type === "static",
    );
    if (deployable.length === 0) {
      return;
    }

    await this.ensureLogin();

    const workRoot = await mkdtemp(join(tmpdir(), "ephemera-zerops-deploy-"));
    const repoDir = join(workRoot, "repo");
    try {
      await checkoutGitRef({
        repoDir,
        repoUrl: input.repoUrl,
        ref: input.ref,
        ...(input.installationToken
          ? { installationToken: input.installationToken }
          : {}),
      });

      const serviceNames = new Set(input.spec.services.map((s) => s.name));
      for (const svc of deployable) {
        const hostname = serviceHostname(prNumber, svc.name);
        const yaml = buildZeropsYamlForService(
          hostname,
          svc,
          prNumber,
          serviceNames,
        );
        const yamlPath = join(repoDir, "zerops.yml");
        await writeFile(yamlPath, yamlStringify(yaml), "utf8");
        await runZcli(
          [
            "service",
            "push",
            hostname,
            "-P",
            this.projectId,
            "--working-dir",
            repoDir,
            "--setup",
            hostname,
            "--zerops-yaml-path",
            "zerops.yml",
            "--no-git",
          ],
          { cwd: repoDir },
        );
      }
    } finally {
      await rm(workRoot, { recursive: true, force: true });
    }
  }

  async getStatus(input: GetStatusInput): Promise<GetStatusResult> {
    const services = await this.servicesForRef(input.providerRef);
    if (services.length === 0) {
      // During provision, empty list is a wait (stacks may not be listable yet).
      // After deploy, empty is a hard failure.
      if (input.phase === "provisioned") {
        return {
          state: "provisioning",
          message: `no services found for providerRef "${input.providerRef}"`,
        };
      }
      return {
        state: "failed",
        message: `no services found for providerRef "${input.providerRef}"`,
      };
    }

    const project = await this.getProject();
    const status = evaluateZeropsStatus(services, project, input.phase);

    // ACTIVE alone is not enough — crash-looping apps still report ACTIVE.
    // Probe the public URL and keep waiting on 5xx / connection errors.
    if (
      input.phase === "deployed" &&
      status.state === "ready" &&
      status.publicUrl
    ) {
      const probe = await probePublicUrl(status.publicUrl);
      if (!probe.ok) {
        const waiting: GetStatusResult = {
          state: "provisioning",
          publicUrl: status.publicUrl,
        };
        const message = probe.message ?? status.message;
        if (message !== undefined) {
          waiting.message = message;
        }
        return waiting;
      }
    }

    return status;
  }

  async destroyEnvironment(input: DestroyEnvironmentInput): Promise<void> {
    await this.ensureLogin();
    const services = await this.servicesForRef(input.providerRef);

    // Also try known names from listing; if listing is empty, nothing to do.
    for (const svc of services) {
      try {
        // Never interactive: --confirm + explicit -P project id.
        await runZcli([
          "service",
          "delete",
          svc.name,
          "-P",
          this.projectId,
          "--confirm",
        ]);
      } catch (err) {
        if (isZcliNotFoundError(err)) {
          continue;
        }
        throw err;
      }
    }
  }
}
