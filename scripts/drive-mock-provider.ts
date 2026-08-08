/**
 * Throwaway Checkpoint 2 driver:
 * create → deploy → poll to ready → destroy
 * Runs the lifecycle twice with the same IDs to prove idempotency.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  getProvider,
  parsePreviewSpec,
  type Provider,
} from "@ephemera/core";

const ENV_ID = "chk2-demo";
const REPO_URL = "https://github.com/example/ephemera-demo.git";
const REF = "main";
const POLL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollUntilReady(provider: Provider, providerRef: string) {
  for (;;) {
    const status = await provider.getStatus({ providerRef, phase: "deployed" });
    console.log(`  status: ${status.state}${status.publicUrl ? ` ${status.publicUrl}` : ""}${status.message ? ` (${status.message})` : ""}`);
    if (status.state === "ready") {
      return status;
    }
    if (status.state === "failed") {
      throw new Error(`environment failed: ${status.message ?? "unknown"}`);
    }
    await sleep(POLL_MS);
  }
}

async function runLifecycle(provider: Provider, label: string) {
  console.log(`\n=== ${label} ===`);

  const examplePath = resolve(import.meta.dirname, "../examples/preview.yml");
  const parsed = parsePreviewSpec(readFileSync(examplePath, "utf8"));
  if (!parsed.ok) {
    throw new Error(parsed.errors.join("\n"));
  }
  const { spec } = parsed;

  const first = await provider.createEnvironment({ envId: ENV_ID, spec });
  const second = await provider.createEnvironment({ envId: ENV_ID, spec });
  if (first.providerRef !== second.providerRef) {
    throw new Error("createEnvironment was not idempotent for the same envId");
  }
  console.log(`  createEnvironment → ${first.providerRef}`);

  await provider.deployCode({
    providerRef: first.providerRef,
    repoUrl: REPO_URL,
    ref: REF,
    spec,
  });
  await provider.deployCode({
    providerRef: first.providerRef,
    repoUrl: REPO_URL,
    ref: REF,
    spec,
  });
  console.log("  deployCode ×2 ok");

  const ready = await pollUntilReady(provider, first.providerRef);
  console.log(`  ready: ${ready.publicUrl}`);

  await provider.destroyEnvironment({ providerRef: first.providerRef });
  await provider.destroyEnvironment({ providerRef: first.providerRef });
  console.log("  destroyEnvironment ×2 ok");
}

async function main() {
  const provider = getProvider();
  console.log(`provider=${provider.name}`);
  console.log(
    `MOCK_PROVISION_MS=${process.env.MOCK_PROVISION_MS ?? "20000 (default)"} MOCK_FAILURE_RATE=${process.env.MOCK_FAILURE_RATE ?? "0"}`,
  );

  await runLifecycle(provider, "run 1");
  await runLifecycle(provider, "run 2 (same IDs)");

  console.log("\nGate OK: MockProvider survived create/deploy/poll/destroy twice.");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
