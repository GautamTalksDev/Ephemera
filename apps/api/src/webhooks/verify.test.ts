import { describe, expect, it } from "vitest";
import { signGitHubPayload, verifyGitHubSignature } from "./verify.js";

describe("verifyGitHubSignature", () => {
  const secret = "test-webhook-secret";
  const body = '{"action":"opened"}';

  it("accepts a valid X-Hub-Signature-256", () => {
    const signature = signGitHubPayload(body, secret);
    expect(verifyGitHubSignature(body, signature, secret)).toBe(true);
  });

  it("rejects a mismatched signature", () => {
    const signature = signGitHubPayload(body, secret);
    expect(verifyGitHubSignature(body, signature, "other-secret")).toBe(false);
    expect(
      verifyGitHubSignature(body, "sha256=deadbeef", secret),
    ).toBe(false);
  });

  it("rejects missing or malformed headers", () => {
    expect(verifyGitHubSignature(body, undefined, secret)).toBe(false);
    expect(verifyGitHubSignature(body, "sha1=abc", secret)).toBe(false);
    expect(verifyGitHubSignature(body, signGitHubPayload(body, secret), "")).toBe(
      false,
    );
  });
});
