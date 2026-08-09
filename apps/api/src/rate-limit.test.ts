import { afterEach, describe, expect, it } from "vitest";
import {
  clientIpFromHeaders,
  resetRateLimitStore,
  takeRateLimit,
} from "./rate-limit.js";

afterEach(() => {
  resetRateLimitStore();
});

describe("takeRateLimit", () => {
  it("allows up to the limit then rejects", () => {
    const key = "ip:1";
    for (let i = 0; i < 3; i++) {
      expect(takeRateLimit(key, 3, 60_000, 1_000 + i).allowed).toBe(true);
    }
    expect(takeRateLimit(key, 3, 60_000, 1_010).allowed).toBe(false);
  });

  it("resets after the window", () => {
    const key = "ip:2";
    expect(takeRateLimit(key, 1, 1000, 0).allowed).toBe(true);
    expect(takeRateLimit(key, 1, 1000, 500).allowed).toBe(false);
    expect(takeRateLimit(key, 1, 1000, 1000).allowed).toBe(true);
  });
});

describe("clientIpFromHeaders", () => {
  it("prefers first X-Forwarded-For hop", () => {
    const headers = new Headers({
      "x-forwarded-for": "1.2.3.4, 10.0.0.1",
      "x-real-ip": "9.9.9.9",
    });
    expect(clientIpFromHeaders(headers)).toBe("1.2.3.4");
  });
});
