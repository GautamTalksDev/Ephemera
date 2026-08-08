import { describe, expect, it } from "vitest";
import type { PreviewSpec } from "../preview/schema.js";
import {
  assertEnvRefsValid,
  translateEnvRefsToZerops,
  translateServiceEnv,
} from "./zerops.js";

const names = new Set(["api", "db", "web"]);

describe("translateEnvRefsToZerops", () => {
  it("renders ${db.DATABASE_URL} on PR 1 as ${pr1db_connectionString}", () => {
    expect(translateEnvRefsToZerops("${db.DATABASE_URL}", 1, names)).toBe(
      "${pr1db_connectionString}",
    );
  });

  it("maps CONNECTION_STRING and passes through other vars", () => {
    expect(translateEnvRefsToZerops("${db.CONNECTION_STRING}", 2, names)).toBe(
      "${pr2db_connectionString}",
    );
    expect(translateEnvRefsToZerops("${web.URL}", 1, names)).toBe(
      "${pr1web_URL}",
    );
  });

  it("translates refs inside a larger env map", () => {
    expect(
      translateServiceEnv(
        {
          NODE_ENV: "production",
          DATABASE_URL: "${db.DATABASE_URL}",
          WEB_ORIGIN: "${web.URL}",
        },
        1,
        names,
      ),
    ).toEqual({
      NODE_ENV: "production",
      DATABASE_URL: "${pr1db_connectionString}",
      WEB_ORIGIN: "${pr1web_URL}",
    });
  });

  it("throws when a reference points at a missing service", () => {
    expect(() =>
      translateEnvRefsToZerops("${missing.DATABASE_URL}", 1, names),
    ).toThrow(/unknown service "missing"/);
  });
});

describe("assertEnvRefsValid", () => {
  const spec: PreviewSpec = {
    version: 1,
    ttlMinutes: 60,
    services: [
      {
        name: "api",
        type: "runtime",
        runtime: "nodejs@22",
        build: { commands: ["npm ci"] },
        start: "node server.js",
        port: 3000,
        public: true,
        env: { DATABASE_URL: "${db.DATABASE_URL}" },
      },
      {
        name: "db",
        type: "database",
        engine: "postgresql@16",
        public: false,
        env: {},
      },
    ],
  };

  it("accepts refs to services in the spec", () => {
    expect(() => assertEnvRefsValid(spec)).not.toThrow();
  });

  it("rejects refs to services not in the spec", () => {
    const bad: PreviewSpec = {
      ...spec,
      services: [
        {
          ...spec.services[0]!,
          env: { DATABASE_URL: "${nope.DATABASE_URL}" },
        },
      ],
    };
    expect(() => assertEnvRefsValid(bad)).toThrow(
      /unknown service "nope".*not in preview\.yml/i,
    );
  });
});
