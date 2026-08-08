import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePreviewSpec } from "./parse.js";
import { resolveEnv } from "./resolve-env.js";
import { validateSpec } from "./validate.js";

const here = dirname(fileURLToPath(import.meta.url));
const examplePath = resolve(here, "../../../../examples/preview.yml");

const validYaml = `
version: 1
services:
  - name: api
    type: runtime
    runtime: nodejs@22
    build:
      commands:
        - npm ci
    start: node server.js
    port: 3000
    public: true
    env:
      DATABASE_URL: \${db.DATABASE_URL}
  - name: db
    type: database
    engine: postgresql@16
`;

describe("parsePreviewSpec", () => {
  it("parses a valid spec", () => {
    const result = parsePreviewSpec(validYaml);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.spec.version).toBe(1);
    expect(result.spec.services).toHaveLength(2);
    expect(result.spec.services[0]).toMatchObject({
      name: "api",
      type: "runtime",
      runtime: "nodejs@22",
      public: true,
    });
    expect(result.spec.ttlMinutes).toBe(60);
  });

  it("parses examples/preview.yml", () => {
    const yaml = readFileSync(examplePath, "utf8");
    const result = parsePreviewSpec(yaml);
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
      }),
    );
    if (!result.ok) {
      throw new Error(result.errors.join("\n"));
    }
    expect(result.spec.services.map((s) => s.name)).toEqual([
      "api",
      "db",
      "web",
    ]);
  });

  it("rejects two public services with path and line", () => {
    const yaml = `
version: 1
services:
  - name: api
    type: runtime
    runtime: nodejs@22
    build:
      commands: [npm ci]
    start: node server.js
    port: 3000
    public: true
  - name: web
    type: static
    build:
      commands: [npm ci]
    port: 8080
    public: true
`;
    const result = parsePreviewSpec(yaml);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors.some((e) => e.includes("services[1].public"))).toBe(
      true,
    );
    expect(result.errors.some((e) => /public: true/.test(e))).toBe(true);
    expect(result.errors.some((e) => /\(line \d+\)/.test(e))).toBe(true);
  });

  it("rejects duplicate service names with path and line", () => {
    const yaml = `
version: 1
services:
  - name: api
    type: runtime
    runtime: nodejs@22
    build:
      commands: [npm ci]
    start: node server.js
    port: 3000
    public: true
  - name: api
    type: static
    build:
      commands: [npm ci]
    port: 8080
`;
    const result = parsePreviewSpec(yaml);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors.some((e) => e.includes("services[1].name"))).toBe(
      true,
    );
    expect(result.errors.some((e) => e.includes('duplicate service name "api"'))).toBe(
      true,
    );
    expect(result.errors.some((e) => /\(line \d+\)/.test(e))).toBe(true);
  });

  it("rejects cyclic environment references with path and line", () => {
    const yaml = `
version: 1
services:
  - name: api
    type: runtime
    runtime: nodejs@22
    build:
      commands: [npm ci]
    start: node server.js
    port: 3000
    public: true
    env:
      A: \${web.B}
  - name: web
    type: static
    build:
      commands: [npm ci]
    port: 8080
    env:
      B: \${api.A}
`;
    const result = parsePreviewSpec(yaml);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors.some((e) => e.includes("cyclic environment reference"))).toBe(
      true,
    );
    expect(result.errors.some((e) => e.includes("services[") && e.includes(".env."))).toBe(
      true,
    );
    expect(result.errors.some((e) => /\(line \d+\)/.test(e))).toBe(true);
  });

  it("rejects unknown runtime with path and line", () => {
    const yaml = `
version: 1
services:
  - name: api
    type: runtime
    runtime: python@3
    build:
      commands: [npm ci]
    start: node server.js
    port: 3000
    public: true
`;
    const result = parsePreviewSpec(yaml);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors.some((e) => e.includes("services[0].runtime"))).toBe(
      true,
    );
    expect(result.errors.some((e) => e.includes("unknown runtime"))).toBe(true);
    expect(result.errors.some((e) => /\(line \d+\)/.test(e))).toBe(true);
  });

  it("rejects missing start command with path and line", () => {
    const yaml = `
version: 1
services:
  - name: api
    type: runtime
    runtime: nodejs@22
    build:
      commands: [npm ci]
    port: 3000
    public: true
`;
    const result = parsePreviewSpec(yaml);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors.some((e) => e.includes("services[0].start"))).toBe(
      true,
    );
    expect(result.errors.some((e) => /start/i.test(e))).toBe(true);
    expect(result.errors.some((e) => /\(line \d+\)/.test(e))).toBe(true);
  });
});

describe("validateSpec", () => {
  it("allows a single public service", () => {
    const result = validateSpec({
      version: 1,
      services: [
        {
          name: "api",
          type: "runtime",
          runtime: "nodejs@22",
          build: { commands: ["npm ci"] },
          start: "node server.js",
          port: 3000,
          public: true,
          env: {},
        },
      ],
    });
    expect(result).toEqual({ ok: true });
  });
});

describe("resolveEnv", () => {
  it("interpolates ${service.VAR} using resolved platform values", () => {
    const parsed = parsePreviewSpec(validYaml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    const env = resolveEnv(parsed.spec, {
      db: { DATABASE_URL: "postgres://db/preview" },
    });

    expect(env.api?.DATABASE_URL).toBe("postgres://db/preview");
  });
});
