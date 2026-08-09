import { describe, expect, it, vi } from "vitest";
import {
  ensureServiceSubdomainAccess,
  publicUrlForHostname,
  waitForServiceIdleAndActive,
  waitForZeropsProcess,
} from "./zerops-subdomain.js";

describe("publicUrlForHostname", () => {
  it("includes port when present", () => {
    expect(publicUrlForHostname("pr1api", "2c0f", 3000)).toBe(
      "https://pr1api-2c0f-3000.prg1.zerops.app",
    );
  });
});

describe("waitForZeropsProcess", () => {
  it("returns when process finishes", async () => {
    const apiGet = vi
      .fn()
      .mockResolvedValueOnce({ id: "p1", status: "RUNNING" })
      .mockResolvedValueOnce({
        id: "p1",
        status: "FINISHED",
        actionName: "stack.enableSubdomainAccess",
      });
    const proc = await waitForZeropsProcess("p1", {
      apiGet,
      intervalMs: 1,
      sleep: async () => {},
    });
    expect(proc.status).toBe("FINISHED");
    expect(apiGet).toHaveBeenCalledWith("/process/p1");
  });

  it("throws when process fails", async () => {
    const apiGet = vi.fn().mockResolvedValue({ id: "p1", status: "FAILED" });
    await expect(
      waitForZeropsProcess("p1", {
        apiGet,
        intervalMs: 1,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/FAILED/);
  });
});

describe("waitForServiceIdleAndActive", () => {
  it("waits until ACTIVE with no busy processes", async () => {
    let n = 0;
    await waitForServiceIdleAndActive({
      serviceId: "svc1",
      serviceName: "pr1api",
      getStack: async () => {
        n += 1;
        return {
          id: "svc1",
          name: "pr1api",
          status: n < 2 ? "DEPLOYING" : "ACTIVE",
        };
      },
      listProcesses: async () =>
        n < 3
          ? [{ id: "b1", status: "RUNNING", actionName: "stack.build" }]
          : [],
      intervalMs: 1,
      sleep: async () => {},
    });
    expect(n).toBeGreaterThanOrEqual(3);
  });
});

describe("ensureServiceSubdomainAccess", () => {
  it("waits for idle+ACTIVE before enable, then polls until resolvable", async () => {
    const logs: string[] = [];
    let access = false;
    let idle = false;
    const apiPut = vi.fn().mockResolvedValue({
      id: "proc1",
      status: "PENDING",
    });
    const apiGet = vi.fn().mockImplementation(async (path: string) => {
      if (path === "/process/proc1") {
        access = true;
        return {
          id: "proc1",
          status: "FINISHED",
          actionName: "stack.enableSubdomainAccess",
        };
      }
      throw new Error(`unexpected GET ${path}`);
    });
    const lookup = vi
      .fn()
      .mockResolvedValue({ address: "1.2.3.4", family: 4 });

    const result = await ensureServiceSubdomainAccess({
      serviceId: "svc1",
      serviceName: "pr1api",
      subdomainHost: "2c0f",
      port: 3000,
      apiGet,
      apiPut,
      getStack: async () => ({
        id: "svc1",
        name: "pr1api",
        status: idle ? "ACTIVE" : "DEPLOYING",
        subdomainAccess: access,
        ports: [{ port: 3000 }],
      }),
      listProcesses: async () => {
        if (!idle) {
          idle = true;
          return [{ id: "b", status: "RUNNING", actionName: "stack.build" }];
        }
        return [];
      },
      lookup: lookup as never,
      sleep: async () => {},
      pollMs: 5_000,
      attempts: 2,
      onLog: (e) => {
        logs.push(`${e.level}:${e.message}`);
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.publicUrl).toContain("pr1api-2c0f-3000");
    }
    expect(apiPut).toHaveBeenCalledWith(
      "/service-stack/svc1/enable-subdomain-access",
    );
    expect(logs.some((l) => l.includes("waiting until ACTIVE"))).toBe(true);
    expect(logs.some((l) => l.includes("enable-subdomain attempt 1/2"))).toBe(
      true,
    );
    expect(logs.some((l) => l.includes("resolvable"))).toBe(true);
  });

  it("does not re-PUT while an enable process is still PENDING", async () => {
    const logs: string[] = [];
    let access = false;
    let processStatus = "PENDING";
    const apiPut = vi.fn();
    const apiGet = vi.fn().mockImplementation(async (path: string) => {
      if (path === "/process/pend1") {
        processStatus = "FINISHED";
        access = true;
        return {
          id: "pend1",
          status: "FINISHED",
          actionName: "stack.enableSubdomainAccess",
        };
      }
      throw new Error(`unexpected GET ${path}`);
    });

    const result = await ensureServiceSubdomainAccess({
      serviceId: "svc1",
      serviceName: "pr1api",
      subdomainHost: "2c0f",
      port: 3000,
      apiGet,
      apiPut,
      getStack: async () => ({
        id: "svc1",
        name: "pr1api",
        status: "ACTIVE",
        subdomainAccess: access,
      }),
      listProcesses: async () =>
        access
          ? []
          : [
              {
                id: "pend1",
                status: processStatus,
                actionName: "stack.enableSubdomainAccess",
              },
            ],
      lookup: vi.fn().mockResolvedValue({ address: "1.2.3.4", family: 4 }) as never,
      sleep: async () => {},
      pollMs: 5_000,
      attempts: 3,
      onLog: (e) => {
        logs.push(`${e.level}:${e.message}`);
      },
    });

    expect(result.ok).toBe(true);
    expect(apiPut).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("not re-queuing"))).toBe(true);
  });

  it("retries enable PUT when still not enabled after process finishes", async () => {
    const apiPut = vi.fn().mockResolvedValue({ id: "p", status: "FINISHED" });
    const apiGet = vi.fn();
    let t = 0;
    const result = await ensureServiceSubdomainAccess({
      serviceId: "svc1",
      serviceName: "pr1api",
      subdomainHost: "2c0f",
      port: 3000,
      apiGet,
      apiPut,
      getStack: async () => ({
        id: "svc1",
        name: "pr1api",
        status: "ACTIVE",
        subdomainAccess: false,
      }),
      listProcesses: async () => [],
      lookup: vi.fn().mockRejectedValue(new Error("ENOTFOUND")) as never,
      sleep: async () => {
        t += 60_000;
      },
      now: () => t,
      pollMs: 100,
      attempts: 3,
    });

    expect(result.ok).toBe(false);
    expect(apiPut).toHaveBeenCalledTimes(3);
  });
});
