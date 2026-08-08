import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { stringify as yamlStringify } from "yaml";
import type { PreviewSpec, Service } from "../preview/schema.js";
import { isZcliNotFoundError, runZcli, ZCLI_TIMEOUT_MS } from "./zerops-zcli.js";
import type {
  CreateEnvironmentInput,
  CreateEnvironmentResult,
  DeployCodeInput,
  DestroyEnvironmentInput,
  GetStatusInput,
  GetStatusResult,
  Provider,
  ProviderStatusState,
} from "./types.js";

const ZEROPS_API_BASE = "https://api.app-prg1.zerops.io/api/rest/public";
const HOSTNAME_MAX = 25;

/** Smallest vertical autoscaling profile (shared CPU, minimal RAM/disk). */
const SMALLEST_VERTICAL = {
  cpuMode: "SHARED",
  minCpu: 1,
  maxCpu: 1,
  minRam: 0.25,
  maxRam: 0.25,
  minDisk: 1,
  maxDisk: 1,
} as const;

type ZeropsServiceStack = {
  id: string;
  name: string;
  status: string;
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
 * Service hostnames: `pr{prNumber}{serviceName}` — lowercase alphanumeric only,
 * max 25 chars, deterministic (idempotent create key).
 */
export function serviceHostname(prNumber: number, serviceName: string): string {
  const prefix = providerRefForPr(prNumber);
  const rest = serviceName.toLowerCase().replace(/[^a-z0-9]/g, "");
  return `${prefix}${rest}`.slice(0, HOSTNAME_MAX);
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
    const base: ImportService = {
      hostname,
      verticalAutoscaling: { ...SMALLEST_VERTICAL },
    };

    if (svc.type === "runtime") {
      return {
        ...base,
        type: svc.runtime,
        // LIGHT projects: do not set mode (NON_HA/HA are unavailable for nodejs).
        minContainers: 1,
        maxContainers: 1,
        enableSubdomainAccess: svc.public,
      };
    }

    if (svc.type === "database") {
      return {
        ...base,
        type: svc.engine,
        mode: "NON_HA",
        priority: 10,
      };
    }

    // static
    return {
      ...base,
      type: "static",
      mode: "NON_HA",
      minContainers: 1,
      maxContainers: 1,
      enableSubdomainAccess: svc.public,
    };
  });
}

function buildZeropsYamlForService(
  hostname: string,
  svc: Service,
): Record<string, unknown> {
  if (svc.type === "database") {
    throw new Error(`cannot build zerops.yaml for database service ${svc.name}`);
  }

  const envVariables =
    Object.keys(svc.env).length > 0 ? svc.env : undefined;

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

async function runGit(
  args: readonly string[],
  cwd?: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `git ${args.join(" ")} timed out after ${ZCLI_TIMEOUT_MS}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`,
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
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `git ${args.join(" ")} exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    });
  });
}

function mapServiceStatus(status: string): ProviderStatusState {
  const s = status.toUpperCase();
  if (
    s.includes("FAIL") ||
    s.includes("ERROR") ||
    s === "STOPPED" ||
    s === "SUSPENDED"
  ) {
    return "failed";
  }
  if (s === "ACTIVE") {
    return "ready";
  }
  // READY_TO_DEPLOY, CREATING, DEPLOYING, STARTING, …
  return "provisioning";
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
      await runGit(["clone", "--depth", "1", "--branch", input.ref, input.repoUrl, repoDir]);

      for (const svc of deployable) {
        const hostname = serviceHostname(prNumber, svc.name);
        const yaml = buildZeropsYamlForService(hostname, svc);
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
      return {
        state: "failed",
        message: `no services found for providerRef "${input.providerRef}"`,
      };
    }

    const states = services.map((s) => mapServiceStatus(s.status));
    if (states.some((s) => s === "failed")) {
      const failed = services.filter(
        (s) => mapServiceStatus(s.status) === "failed",
      );
      return {
        state: "failed",
        message: failed.map((s) => `${s.name}:${s.status}`).join(", "),
      };
    }
    if (states.some((s) => s === "provisioning")) {
      return {
        state: "provisioning",
        message: services.map((s) => `${s.name}:${s.status}`).join(", "),
      };
    }

    const project = await this.getProject();
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

    const result: GetStatusResult = {
      state: "ready",
      message: services.map((s) => `${s.name}:${s.status}`).join(", "),
    };
    if (publicUrl !== undefined) {
      result.publicUrl = publicUrl;
    }
    return result;
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
