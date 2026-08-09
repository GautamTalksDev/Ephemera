import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { githubWebhookPath } from "../webhooks/github.js";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function getAdminTokenFromEnv(): string {
  return process.env.EPHEMERA_ADMIN_TOKEN?.trim() ?? "";
}

/** Loud boot warning when the admin token is missing (fail-closed mutations). */
export function warnIfAdminTokenMissing(
  getToken: () => string = getAdminTokenFromEnv,
  log: (msg: string) => void = console.error,
): void {
  if (getToken()) {
    return;
  }
  log(
    [
      "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
      "EPHEMERA_ADMIN_TOKEN is unset — all mutating API requests will be REJECTED (fail closed).",
      "Set EPHEMERA_ADMIN_TOKEN and send Authorization: Bearer <token> on POST/PATCH/DELETE.",
      "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
    ].join("\n"),
  );
}

function bearerToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }
  const match = /^Bearer\s+(\S+)/i.exec(header.trim());
  return match?.[1] ?? null;
}

/** Constant-time compare; false when lengths differ. */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

export type AdminAuthOptions = {
  getAdminToken?: () => string;
  /** Paths exempt from bearer auth (still subject to their own verification). */
  exemptPaths?: string[];
};

/**
 * Require Authorization: Bearer <EPHEMERA_ADMIN_TOKEN> on mutating methods.
 * GET/HEAD/OPTIONS stay public. Fail closed when the token env is unset.
 */
export function adminAuthMiddleware(
  options: AdminAuthOptions = {},
): MiddlewareHandler {
  const getToken = options.getAdminToken ?? getAdminTokenFromEnv;
  const exempt = new Set(options.exemptPaths ?? [githubWebhookPath]);

  return async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (!MUTATING.has(method)) {
      return next();
    }

    const path = c.req.path;
    if (exempt.has(path)) {
      return next();
    }

    const expected = getToken();
    if (!expected) {
      return c.json({ error: "unauthorized" }, 401);
    }

    const provided = bearerToken(c.req.header("authorization"));
    if (!provided || !timingSafeStringEqual(provided, expected)) {
      return c.json({ error: "unauthorized" }, 401);
    }

    return next();
  };
}
