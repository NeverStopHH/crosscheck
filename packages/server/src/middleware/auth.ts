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