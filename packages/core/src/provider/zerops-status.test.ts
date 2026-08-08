import { afterEach, describe, expect, it, vi } from "vitest";
import {
  evaluateZeropsStatus,
  mapZeropsServiceStatus,
  ZeropsProvider,
} from "./zerops.js";

const project = { id: "proj", zeropsSubdomainHost: "2c0f" };

const dbActive = {
  id: "db1",
  name: "pr1db",
  status: "ACTIVE",
  base: "postgresql:single@16",
};

const apiReadyToDeploy = {
  id: "api1",
  name: "pr1api",
  status: "READY_TO_DEPLOY",
  base: "ubuntu/nodejs@22",
  subdomainAccess: true,
  ports: [{ port: 3000 }],
};

const apiActive = {
  ...apiReadyToDeploy,
  status: "ACTIVE",
};

describe("mapZeropsServiceStatus", () => {
  it("maps NEW/CREATING/DEPLOYING/STARTING/RESTARTING → provisioning", () => {
    for (const status of [
      "NEW",
      "CREATING",
      "DEPLOYING",
      "STARTING",
      "RESTARTING",
    ]) {
      expect(mapZeropsServiceStatus(status, "provisioned")).toBe("provisioning");
      expect(mapZeropsServiceStatus(status, "deployed")).toBe("provisioning");
    }
  });

  it("READY_TO_DEPLOY is ready at provisioned, provisioning at deployed", () => {
    expect(mapZeropsServiceStatus("READY_TO_DEPLOY", "provisioned")).toBe(
      "ready",
    );
    expect(mapZeropsServiceStatus("READY_TO_DEPLOY", "deployed")).toBe(
      "provisioning",
    );
  });

  it("ACTIVE → ready", () => {
    expect(mapZeropsServiceStatus("ACTIVE", "provisioned")).toBe("ready");
    expect(mapZeropsServiceStatus("ACTIVE", "deployed")).toBe("ready");
  });

  it("unrecognised → provisioning and logs raw value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(mapZeropsServiceStatus("SOME_FUTURE_STATE", "provisioned")).toBe(
      "provisioning",
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("SOME_FUTURE_STATE"),
    );
    warn.mockRestore();
  });
});

describe("evaluateZeropsStatus phases", () => {
  it("provisioned: db ACTIVE + api READY_TO_DEPLOY → ready", () => {
    const result = evaluateZeropsStatus(
      [dbActive, apiReadyToDeploy],
      project,
      "provisioned",
    );
    expect(result.state).toBe("ready");
  });

  it("provisioned: NEW/CREATING services wait", () => {
    const result = evaluateZeropsStatus(
      [
        { ...dbActive, status: "CREATING" },
        { ...apiReadyToDeploy, status: "NEW" },
      ],
      project,
      "provisioned",
    );
    expect(result.state).toBe("provisioning");
  });

  it("deployed: db ACTIVE + api READY_TO_DEPLOY → not ready", () => {
    const result = evaluateZeropsStatus(
      [dbActive, apiReadyToDeploy],
      project,
      "deployed",
    );
    expect(result.state).toBe("provisioning");
    expect(result.publicUrl).toBeUndefined();
  });

  it("provisioned: all ACTIVE + subdomain → ready", () => {
    const result = evaluateZeropsStatus(
      [dbActive, apiActive],
      project,
      "provisioned",
    );
    expect(result.state).toBe("ready");
  });

  it("deployed: all ACTIVE + subdomain → ready with publicUrl", () => {
    const result = evaluateZeropsStatus(
      [dbActive, apiActive],
      project,
      "deployed",
    );
    expect(result.state).toBe("ready");
    expect(result.publicUrl).toBe(
      "https://pr1api-2c0f-3000.prg1.zerops.app",
    );
  });
});

describe("ZeropsProvider.getStatus with mocked service-list", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockFetch(
    services: unknown[],
    subdomainHost = "2c0f",
    publicStatus = 200,
  ) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes("/service-stack")) {
          return new Response(JSON.stringify({ list: services }), {
            status: 200,
          });
        }
        if (u.match(/\/project\/[^/]+$/)) {
          return new Response(
            JSON.stringify({ id: "proj", zeropsSubdomainHost: subdomainHost }),
            { status: 200 },
          );
        }
        if (u.includes("zerops.app")) {
          return new Response("ok", { status: publicStatus });
        }
        return new Response("not found", { status: 404 });
      }),
    );
  }

  it("phase provisioned: READY_TO_DEPLOY runtime is ready", async () => {
    mockFetch([dbActive, apiReadyToDeploy]);
    const provider = new ZeropsProvider({
      token: "test-token",
      projectId: "proj",
    });
    const status = await provider.getStatus({
      providerRef: "pr1",
      phase: "provisioned",
    });
    expect(status.state).toBe("ready");
  });

  it("phase deployed: READY_TO_DEPLOY runtime is not ready", async () => {
    mockFetch([dbActive, apiReadyToDeploy]);
    const provider = new ZeropsProvider({
      token: "test-token",
      projectId: "proj",
    });
    const status = await provider.getStatus({
      providerRef: "pr1",
      phase: "deployed",
    });
    expect(status.state).toBe("provisioning");
  });

  it("phase deployed: all ACTIVE + subdomain + HTTP ok is ready", async () => {
    mockFetch([dbActive, apiActive], "2c0f", 200);
    const provider = new ZeropsProvider({
      token: "test-token",
      projectId: "proj",
    });
    const status = await provider.getStatus({
      providerRef: "pr1",
      phase: "deployed",
    });
    expect(status.state).toBe("ready");
    expect(status.publicUrl).toBe("https://pr1api-2c0f-3000.prg1.zerops.app");
  });

  it("phase deployed: ACTIVE but public URL 5xx keeps waiting", async () => {
    mockFetch([dbActive, apiActive], "2c0f", 502);
    const provider = new ZeropsProvider({
      token: "test-token",
      projectId: "proj",
    });
    const status = await provider.getStatus({
      providerRef: "pr1",
      phase: "deployed",
    });
    expect(status.state).toBe("provisioning");
    expect(status.publicUrl).toBe("https://pr1api-2c0f-3000.prg1.zerops.app");
    expect(status.message).toMatch(/returned 502/);
  });

  it("phase provisioned: all ACTIVE is also ready", async () => {
    mockFetch([dbActive, apiActive]);
    const provider = new ZeropsProvider({
      token: "test-token",
      projectId: "proj",
    });
    const status = await provider.getStatus({
      providerRef: "pr1",
      phase: "provisioned",
    });
    expect(status.state).toBe("ready");
  });

  it("phase provisioned: empty list is wait, not failed", async () => {
    mockFetch([]);
    const provider = new ZeropsProvider({
      token: "test-token",
      projectId: "proj",
    });
    const status = await provider.getStatus({
      providerRef: "pr1",
      phase: "provisioned",
    });
    expect(status.state).toBe("provisioning");
    expect(status.message).toMatch(/no services found for providerRef/i);
  });
});
