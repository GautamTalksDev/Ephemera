/**
 * Checkpoint 7 smoke: create → deploy → poll → destroy against a real Zerops project.
 * Usage: PROVIDER=zerops pnpm smoke
 *
 * Uses a tiny local git repo (no npm install) so push stays well under the zcli timeout.
 * Run twice: the second create must skip already-existing hostnames (no duplicates).
 */
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  getProvider,
  parsePreviewSpec,
  resetProviderCache,
  serviceHostname,
  type Provider,
} from "@ephemera/core";

const PR_NUMBER = Number(process.env.SMOKE_PR_NUMBER ?? "9001");
const ENV_ID = `smoke-zerops-${PR_NUMBER}`;
const POLL_MS = 3_000;
const POLL_TIMEOUT_MS = 5 * 60_000;

const SMOKE_SPEC = `
version: 1
services:
  - name: api
    type: runtime
    runtime: nodejs@22
    build:
      commands:
        - echo build-ok
    start: node server.js
    port: 3000
    public: true
ttlMinutes: 30
`;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function now(): number {
  return Date.now();
}

function fmtMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

async function run(
  cmd: string,
  args: string[],
  cwd?: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`));
    });
  });
}

async function makeTinyRepo(): Promise<{ repoUrl: string; cleanup: () => Promise<void> }> {
  const dir = join(tmpdir(), `ephemera-smoke-repo-${PR_NUMBER}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "server.js"),
    `require("http").createServer((_q, s) => { s.end("ephemera-smoke-ok"); }).listen(3000);\n`,
    "utf8",
  );
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "smoke", private: true }), "utf8");
  await run("git", ["init"], dir);
  await run("git", ["config", "user.email", "smoke@ephemera.local"], dir);
  await run("git", ["config", "user.name", "Ephemera Smoke"], dir);
  await run("git", ["add", "."], dir);
  await run("git", ["commit", "-m", "smoke"], dir);
  await run("git", ["branch", "-M", "main"], dir);
  return {
    repoUrl: dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function pollUntilReady(provider: Provider, providerRef: string) {
  const started = now();
  for (;;) {
    const status = await provider.getStatus({ providerRef, phase: "deployed" });
    console.log(
      `  status: ${status.state}${status.publicUrl ? ` ${status.publicUrl}` : ""}${status.message ? ` (${status.message})` : ""}`,
    );
    if (status.state === "ready") {
      return status;
    }
    if (status.state === "failed") {
      throw new Error(`environment failed: ${status.message ?? "unknown"}`);
    }
    if (now() - started > POLL_TIMEOUT_MS) {
      throw new Error(`timed out waiting for ready after ${fmtMs(POLL_TIMEOUT_MS)}`);
    }
    await sleep(POLL_MS);
  }
}

async function listMatchingHostnames(prefix: string): Promise<string[]> {
  const token = process.env.ZEROPS_API_TOKEN?.trim();
  const projectId = process.env.ZEROPS_PROJECT_ID?.trim();
  if (!token || !projectId) {
    return [];
  }
  const res = await fetch(
    `https://api.app-prg1.zerops.io/api/rest/public/project/${projectId}/service-stack`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const body = (await res.json()) as { list?: Array<{ name: string; isSystem?: boolean }> };
  return (body.list ?? [])
    .filter((s) => !s.isSystem && (s.name === prefix || s.name.startsWith(prefix)))
    .map((s) => s.name)
    .sort();
}

async function runLifecycle(label: string, repoUrl: string) {
  console.log(`\n=== ${label} ===`);
  const timings: Record<string, number> = {};
  resetProviderCache();
  const provider = getProvider();
  if (provider.name !== "zerops") {
    throw new Error(`expected PROVIDER=zerops, got ${provider.name}`);
  }

  const parsed = parsePreviewSpec(SMOKE_SPEC);
  if (!parsed.ok) {
    throw new Error(parsed.errors.join("\n"));
  }
  const { spec } = parsed;
  const expectedHost = serviceHostname(PR_NUMBER, "api");

  let t0 = now();
  const created = await provider.createEnvironment({
    envId: ENV_ID,
    spec,
    prNumber: PR_NUMBER,
  });
  timings.create = now() - t0;
  console.log(`  createEnvironment → ${created.providerRef} (${fmtMs(timings.create)})`);
  console.log(`  expected hostname: ${expectedHost}`);

  const afterCreate = await listMatchingHostnames(created.providerRef);
  console.log(`  services after create: ${afterCreate.join(", ") || "(none)"}`);

  t0 = now();
  await provider.deployCode({
    envId: ENV_ID,
    providerRef: created.providerRef,
    repoUrl,
    ref: "main",
    spec,
  });
  timings.deploy = now() - t0;
  console.log(`  deployCode ok (${fmtMs(timings.deploy)})`);

  t0 = now();
  const ready = await pollUntilReady(provider, created.providerRef);
  timings.poll = now() - t0;
  console.log(`  ready: ${ready.publicUrl ?? "(no publicUrl)"} (${fmtMs(timings.poll)})`);

  t0 = now();
  await provider.destroyEnvironment({ providerRef: created.providerRef });
  // Idempotent second destroy
  await provider.destroyEnvironment({ providerRef: created.providerRef });
  timings.destroy = now() - t0;
  console.log(`  destroyEnvironment ×2 ok (${fmtMs(timings.destroy)})`);

  const afterDestroy = await listMatchingHostnames(created.providerRef);
  if (afterDestroy.length > 0) {
    throw new Error(`services still present after destroy: ${afterDestroy.join(", ")}`);
  }

  console.log(
    `  timings: create=${fmtMs(timings.create)} deploy=${fmtMs(timings.deploy)} poll=${fmtMs(timings.poll)} destroy=${fmtMs(timings.destroy)} total=${fmtMs(Object.values(timings).reduce((a, b) => a + b, 0))}`,
  );

  return { providerRef: created.providerRef, hostnamesAfterCreate: afterCreate };
}

async function main() {
  if (!process.env.ZEROPS_API_TOKEN?.trim() || !process.env.ZEROPS_PROJECT_ID?.trim()) {
    throw new Error("ZEROPS_API_TOKEN and ZEROPS_PROJECT_ID must be set");
  }

  console.log(`PROVIDER=${process.env.PROVIDER ?? ""}`);
  console.log(`ZEROPS_PROJECT_ID=${process.env.ZEROPS_PROJECT_ID}`);
  console.log(`SMOKE_PR_NUMBER=${PR_NUMBER}`);

  const repo = await makeTinyRepo();
  try {
    const first = await runLifecycle("run 1", repo.repoUrl);
    // Leave a short gap, then run again — create must not duplicate services.
    // We destroyed at end of run 1, so run 2 recreates; to prove skip-existing,
    // create once, create again without destroy in between.
    console.log("\n=== idempotent create check (no destroy between) ===");
    resetProviderCache();
    const provider = getProvider();
    const parsed = parsePreviewSpec(SMOKE_SPEC);
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"));

    const a = await provider.createEnvironment({
      envId: ENV_ID,
      spec: parsed.spec,
      prNumber: PR_NUMBER,
    });
    const hosts1 = await listMatchingHostnames(a.providerRef);
    const b = await provider.createEnvironment({
      envId: ENV_ID,
      spec: parsed.spec,
      prNumber: PR_NUMBER,
    });
    const hosts2 = await listMatchingHostnames(b.providerRef);
    if (a.providerRef !== b.providerRef) {
      throw new Error("providerRef drifted between creates");
    }
    if (hosts1.join(",") !== hosts2.join(",")) {
      throw new Error(
        `second create duplicated services: before=${hosts1.join(",")} after=${hosts2.join(",")}`,
      );
    }
    console.log(`  create ×2 kept hostnames: ${hosts2.join(", ") || "(none)"}`);

    const second = await runLifecycle("run 2 (full)", repo.repoUrl);
    console.log("\nSMOKE OK");
    console.log(`  run1 ref=${first.providerRef} hosts=${first.hostnamesAfterCreate.join(",")}`);
    console.log(`  run2 ref=${second.providerRef} hosts=${second.hostnamesAfterCreate.join(",")}`);
  } finally {
    await repo.cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
