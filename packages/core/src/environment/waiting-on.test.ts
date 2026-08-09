import { describe, expect, it } from "vitest";
import { deriveWaitingOn } from "./waiting-on.js";

describe("deriveWaitingOn", () => {
  const base = {
    desiredState: "running",
    errorMessage: null as string | null,
    degraded: false,
    expiresAt: new Date(Date.now() + 60_000),
  };

  it("follows actualState, not a stale narrative", () => {
    expect(
      deriveWaitingOn({ ...base, actualState: "deploying" }),
    ).toMatch(/deployCode/);
    expect(
      deriveWaitingOn({ ...base, actualState: "ready" }),
    ).toBe("live");
    expect(
      deriveWaitingOn({
        ...base,
        actualState: "failed",
        errorMessage: "boom",
      }),
    ).toBe("boom");
  });

  it("ready + degraded uses errorMessage", () => {
    expect(
      deriveWaitingOn({
        ...base,
        actualState: "ready",
        degraded: true,
        errorMessage: "public URL returned 502",
      }),
    ).toBe("degraded — public URL returned 502");
  });
});
