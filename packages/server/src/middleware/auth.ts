import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";

import { hashApiKey, isTokenEqual } from "../auth/keys.ts";
import { developers } from "../db/schema.ts";
import { fail } from "../http/envelope.ts";
import type { AppDeps, AppEnv } from "../types.ts";

const BEARER_PREFIX = "Bearer ";

export const bearerToken = (header: string | undefined): string | null => {
  if (!header?.startsWith(BEARER_PREFIX)) {
    return null;
  }
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
};

export const requireAdmin = (
  adminToken: string | null,
): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    if (adminToken === null) {
      return fail(
        c,
        503,
        "admin_disabled",
        "admin registration is not available on this server",
      );
    }
    const presented = bearerToken(c.req.header("Authorization"));
    if (presented === null || !isTokenEqual(presented, adminToken)) {
      return fail(c, 401, "unauthorized", "invalid admin token");
    }
    await next();
  };
};

/**
 * WRITE IS A TOKEN, READ IS A MEMBER — the same asymmetry team-settings uses,
 * and here it is load-bearing twice over.
 *
 * A CI reporter has no developer account and cannot have one: it is not a
 * person, and minting a developer row for it would put a teammate in the
 * graph who does not exist. So the write cannot be `developerAuth`. It is
 * also not the ADMIN token — that one flips `pin_policy` and
 * `suspect_attribution` as well, and a workflow secret is readable by every
 * workflow in the repository, including the ones a fork can influence. One
 * token, one capability.
 *
 * Absent token = the route REFUSES rather than opens. A hub with no CI token
 * has no reporter, and `coverage.ci` says `unavailable` for it — a documented
 * refusal, which is what a silent absence would not be.
 */
export const requireCiToken = (
  ciToken: string | null,
): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    if (ciToken === null) {
      return fail(
        c,
        503,
        "ci_disabled",
        "CI ingestion is not configured on this server (CROSSCHECK_CI_TOKEN)",
      );
    }
    const presented = bearerToken(c.req.header("Authorization"));
    if (presented === null || !isTokenEqual(presented, ciToken)) {
      return fail(c, 401, "unauthorized", "invalid CI token");
    }
    await next();
  };
};

export const developerAuth = (deps: AppDeps): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const presented = bearerToken(c.req.header("Authorization"));
    if (presented === null) {
      return fail(c, 401, "unauthorized", "missing bearer api key");
    }
    const apiKeyHash = hashApiKey(presented);
    const rows = await deps.db
      .select({
        id: developers.id,
        name: developers.name,
        email: developers.email,
      })
      .from(developers)
      .where(eq(developers.apiKeyHash, apiKeyHash))
      .limit(1);
    const developer = rows[0];
    if (developer === undefined) {
      return fail(c, 401, "unauthorized", "unknown api key");
    }
    c.set("developer", developer);
    await next();
  };
};