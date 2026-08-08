import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePreviewSpec } from "../preview/parse.js";
import { importCompose } from "./import-compose.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(
  here,
  "../../../../examples/docker-compose.sample.yml",
);

describe("importCompose", () => {
  it("imports a real 3-service compose into a valid preview.yml", () => {
    const yaml = readFileSync(fixture, "utf8");
    const result = importCompose(yaml);

    const parsed = parsePreviewSpec(result.previewYml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error(parsed.errors.join("\n"));
    }

    expect(parsed.spec.services).toHaveLength(3);
    expect(parsed.spec.services.filter((s) => s.public)).toHaveLength(1);
    expect(
      parsed.spec.services.some(
        (s) => s.type === "database" && s.engine === "postgresql@16",
      ),
    ).toBe(true);
    expect(
      parsed.spec.services.some(
        (s) => s.type === "runtime" && s.runtime === "nodejs@22",
      ),
    ).toBe(true);

    // Honest warnings for unmapped compose features.
    expect(result.warnings.some((w) => /volumes/i.test(w))).toBe(true);
    expect(result.warnings.some((w) => /depends_on/i.test(w))).toBe(true);
  });

  it("warns and skips unknown images instead of inventing a mapping", () => {
    const result = importCompose(`
services:
  redis:
    image: redis:7
  api:
    image: node:22
    command: node server.js
    ports: ["3000:3000"]
`);
    expect(result.warnings.some((w) => /redis/i.test(w))).toBe(true);
    expect(result.spec.services.every((s) => s.name !== "redis")).toBe(true);
    expect(parsePreviewSpec(result.previewYml).ok).toBe(true);
  });
});
