import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsePreviewSpec } from "@ephemera/core";
import { createDb, createPool } from "./client.js";
import { appendEvent, createEnvironment, createRepo } from "./repo.js";
import { environments, events, repos } from "./schema.js";

async function main() {
  const pool = createPool();
  const db = createDb(pool);

  try {
    const examplePath = resolve(import.meta.dirname, "../../../../examples/preview.yml");
    const parsed = parsePreviewSpec(readFileSync(examplePath, "utf8"));
    if (!parsed.ok) {
      throw new Error(`invalid examples/preview.yml:\n${parsed.errors.join("\n")}`);
    }
    const specJson = parsed.spec as unknown as Record<string, unknown>;

    // Reset demo data for a deterministic seed.
    await db.delete(events);
    await db.delete(environments);
    await db.delete(repos);

    const repo = await createRepo(db, {
      fullName: "ephemera-demo/hello",
      installationToken: "demo-installation-token",
      previewYmlPath: "preview.yml",
      defaultTtlMinutes: 60,
    });

    const now = Date.now();
    const hour = 60 * 60 * 1000;

    const ready = await createEnvironment(db, {
      repoId: repo.id,
      prNumber: 1,
      headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      branch: "feat/ready-demo",
      providerRef: "mock:demo-pr-1",
      desiredState: "running",
      actualState: "ready",
      publicUrl: "https://demo-pr-1.mock.ephemera.dev",
      errorMessage: null,
      specJson,
      expiresAt: new Date(now + hour),
      lastReconciledAt: new Date(now - 5 * 60 * 1000),
    });

    const provisioning = await createEnvironment(db, {
      repoId: repo.id,
      prNumber: 2,
      headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      branch: "feat/provisioning-demo",
      providerRef: "mock:demo-pr-2",
      desiredState: "running",
      actualState: "provisioning",
      publicUrl: null,
      errorMessage: null,
      specJson,
      expiresAt: new Date(now + hour),
      lastReconciledAt: null,
    });

    const failed = await createEnvironment(db, {
      repoId: repo.id,
      prNumber: 3,
      headSha: "cccccccccccccccccccccccccccccccccccccccc",
      branch: "feat/failed-demo",
      providerRef: "mock:demo-pr-3",
      desiredState: "running",
      actualState: "failed",
      publicUrl: null,
      errorMessage: "mock provider failed during deploy",
      specJson,
      expiresAt: new Date(now + hour),
      lastReconciledAt: new Date(now - 30 * 60 * 1000),
    });

    await appendEvent(db, {
      environmentId: ready.id,
      level: "info",
      step: "ready",
      message: "environment is ready",
    });
    await appendEvent(db, {
      environmentId: provisioning.id,
      level: "info",
      step: "provision",
      message: "waiting for provider to become ready",
    });
    await appendEvent(db, {
      environmentId: failed.id,
      level: "error",
      step: "deploy",
      message: "mock provider failed during deploy",
    });

    console.log("Seeded demo repo ephemera-demo/hello");
    console.log(`  ready         ${ready.id} (PR #${ready.prNumber})`);
    console.log(`  provisioning  ${provisioning.id} (PR #${provisioning.prNumber})`);
    console.log(`  failed        ${failed.id} (PR #${failed.prNumber})`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
