import { createHmac, timingSafeEqual } from "node:crypto";

function asBodyBuffer(rawBody: string | Buffer): Buffer {
  return Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
}

/**
 * Verify GitHub's X-Hub-Signature-256 header against the raw request body.
 * HMAC is over the exact bytes received — never a re-serialized JSON object.
 * Uses timingSafeEqual to avoid leaking the secret via timing.
 */
export function verifyGitHubSignature(
  rawBody: string | Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!secret) {
    return false;
  }
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const digest = createHmac("sha256", secret)
    .update(asBodyBuffer(rawBody))
    .digest("hex");
  const expected = Buffer.from(`sha256=${digest}`, "utf8");
  const actual = Buffer.from(signatureHeader, "utf8");

  if (expected.length !== actual.length) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}

export function signGitHubPayload(rawBody: string | Buffer, secret: string): string {
  const digest = createHmac("sha256", secret)
    .update(asBodyBuffer(rawBody))
    .digest("hex");
  return `sha256=${digest}`;
}
