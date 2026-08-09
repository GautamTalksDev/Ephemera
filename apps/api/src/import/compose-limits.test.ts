import { describe, expect, it } from "vitest";
import {
  checkComposeStructure,
  MAX_COMPOSE_NESTING_DEPTH,
  MAX_COMPOSE_SERVICES,
  nestingDepth,
} from "./compose-limits.js";

describe("nestingDepth", () => {
  it("counts nested maps", () => {
    expect(nestingDepth({ a: { b: { c: 1 } } })).toBe(3);
  });

  it("counts arrays", () => {
    expect(nestingDepth([[[["x"]]]])).toBe(4);
  });
});

describe("checkComposeStructure", () => {
  it("accepts a small compose", () => {
    const r = checkComposeStructure(`
services:
  api:
    image: node:22
`);
    expect(r).toEqual({ ok: true });
  });

  it(`rejects more than ${MAX_COMPOSE_SERVICES} services`, () => {
    const services = Array.from(
      { length: MAX_COMPOSE_SERVICES + 1 },
      (_, i) => `  s${i}:\n    image: node:22`,
    ).join("\n");
    const r = checkComposeStructure(`services:\n${services}\n`);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/maximum is 20/);
    }
  });

  it(`rejects nesting deeper than ${MAX_COMPOSE_NESTING_DEPTH}`, () => {
    // Build a: { a: { a: ... } } deeper than the limit.
    let yaml = "0";
    for (let i = 0; i < MAX_COMPOSE_NESTING_DEPTH + 2; i++) {
      yaml = `a:\n  ${yaml.replace(/\n/g, "\n  ")}`;
    }
    const r = checkComposeStructure(yaml);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/nesting exceeds/);
    }
  });
});
