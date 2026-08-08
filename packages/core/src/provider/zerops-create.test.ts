import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as yamlParse } from "yaml";
import type { PreviewSpec } from "../preview/schema.js";
import * as zcli from "./zerops-zcli.js";
import { ZeropsProvider, serviceHostname } from "./zerops.js";
import {
  ZCLI_DELETE_TIMEOUT_MS,
  ZCLI_IMPORT_TIMEOUT_MS,
  ZCLI_PUSH_TIMEOUT_MS,
  timeoutForZcliArgs,
} from "./zerops-zcli.js";

const threeServiceSpec: PreviewSpec = {
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
      env: {},
    },
    {
      name: "db",
      type: "database",
      engine: "postgresql@16",
      public: false,
      env: {},
    },
    {
      name: "web",
      type: "static",
      build: { commands: ["npm run build"] },
      port: 80,
      public: true,
      env: {},
    },
  ],
};

describe("timeoutForZcliArgs", () => {
  it("uses 300s for service-import, 420s for push, 120s for delete", () => {
    expect(timeoutForZcliArgs(["project", "service-import", "x.yml", "-P", "p"])).toBe(
      ZCLI_IMPORT_TIMEOUT_MS,
    );
    expect(ZCLI_IMPORT_TIMEOUT_MS).toBe(300_000);
    expect(timeoutForZcliArgs(["service", "push", "h", "-P", "p"])).toBe(
      ZCLI_PUSH_TIMEOUT_MS,
    );
    expect(
      timeoutForZcliArgs(["service", "delete", "h", "-P", "p", "--confirm"]),
    ).toBe(ZCLI_DELETE_TIMEOUT_MS);
    expect(ZCLI_PUSH_TIMEOUT_MS).toBe(420_000);
    expect(ZCLI_DELETE_TIMEOUT_MS).toBe(120_000);
  });
});

describe("ZeropsProvider.createEnvironment partial import", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function mockListServices(names: string[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes("/service-stack")) {
          return new Response(
            JSON.stringify({
              list: names.map((name, i) => ({
                id: `svc-${i}`,
                name,
                status: "ACTIVE",
              })),
            }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );
  }

  it("on retry after partial import, only creates missing hostnames", async () => {
    const prNumber = 42;
    const existingApi = serviceHostname(prNumber, "api");
    mockListServices([existingApi]);

    let importYaml: unknown;
    vi.spyOn(zcli, "runZcli").mockImplementation(async (args) => {
      if (args[0] === "login") {
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "project" && args[1] === "service-import") {
        const raw = await readFile(String(args[2]), "utf8");
        importYaml = yamlParse(raw);
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected zcli ${args.join(" ")}`);
    });

    const provider = new ZeropsProvider({
      token: "test-token",
      projectId: "proj",
    });
    const result = await provider.createEnvironment({
      envId: "env-partial",
      prNumber,
      spec: threeServiceSpec,
    });

    expect(result.providerRef).toBe("pr42");
    expect(importYaml).toEqual({
      services: expect.arrayContaining([
        expect.objectContaining({ hostname: serviceHostname(prNumber, "db") }),
        expect.objectContaining({ hostname: serviceHostname(prNumber, "web") }),
      ]),
    });
    const hostnames = (
      importYaml as { services: Array<{ hostname: string }> }
    ).services.map((s) => s.hostname);
    expect(hostnames).toHaveLength(2);
    expect(hostnames).not.toContain(existingApi);
  });

  it("when all hostnames already exist, skips import entirely", async () => {
    const prNumber = 7;
    mockListServices(
      threeServiceSpec.services.map((s) => serviceHostname(prNumber, s.name)),
    );
    const runZcli = vi.spyOn(zcli, "runZcli");

    const provider = new ZeropsProvider({
      token: "test-token",
      projectId: "proj",
    });
    const result = await provider.createEnvironment({
      envId: "env-all-exist",
      prNumber,
      spec: threeServiceSpec,
    });

    expect(result.providerRef).toBe("pr7");
    expect(runZcli).not.toHaveBeenCalled();
  });
});
