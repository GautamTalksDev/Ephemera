/**
 * Checkpoint 6 gate: import a real 3-service compose file; require valid preview.yml
 * that passes parsePreviewSpec, with honest warnings.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { importCompose, parsePreviewSpec } from "@ephemera/core";

const fixture = resolve(
  import.meta.dirname,
  "../examples/docker-compose.sample.yml",
);
const compose = readFileSync(fixture, "utf8");
const result = importCompose(compose);
const parsed = parsePreviewSpec(result.previewYml);

console.log("--- preview.yml ---");
console.log(result.previewYml);
console.log("--- warnings ---");
for (const w of result.warnings) {
  console.log("-", w);
}

if (!parsed.ok) {
  throw new Error(`parsePreviewSpec failed:\n${parsed.errors.join("\n")}`);
}

if (parsed.spec.services.length < 3) {
  throw new Error(`expected >= 3 services, got ${parsed.spec.services.length}`);
}

if (!result.warnings.some((w) => /volume/i.test(w))) {
  throw new Error("expected a volumes warning");
}
if (!result.warnings.some((w) => /depends_on/i.test(w))) {
  throw new Error("expected a depends_on warning");
}

console.log(
  `\nGate OK: valid preview.yml with ${parsed.spec.services.length} services and ${result.warnings.length} warning(s).`,
);
