/** @jsxImportSource hono/jsx */
/**
 * /ui — the v0.5 human-facing web surface (DESIGN.md §2.1: feed, member
 * list, click-to-approve). Served by the HUB itself, from this FSL-licensed
 * package: the UI is hub functionality, it reads the same services under
 * the same visibility rules as the API, and it ships as server-rendered
 * hono/jsx with zero client JS, no build step, and no external assets.
 *
 * THIS FILE is the auth shell: security headers, the stylesheet, the
 * login/logout exchange, and the session middleware. The page handlers live
 * in routes/ui-pages.tsx, mounted below BEHIND the middleware.
 *
 * AUTH: /ui/login exchanges a developer API key for a signed HttpOnly
 * SameSite=Strict cookie (ui/session.ts documents the token, the secret,
 * and rotation). Every other /ui route requires the session; the developer
 * it names is the READER for every visibility rule. The API key itself is
 * checked once here and never rendered, logged, or stored.
 *
 * HEADERS: every response — pages, redirects, the stylesheet — carries the
 * strict CSP (ui/constants.ts UI_CSP), nosniff, no-referrer; pages are
 * no-store because they render private team data.
 */
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";

import { hashApiKey } from "../auth/keys.ts";
import { developers } from "../db/schema.ts";
import {
  UI_CSP,
  UI_MAX_API_KEY_FORM_CHARS,
  UI_SESSION_COOKIE_NAME,
  UI_SESSION_TTL_SECONDS,
  UI_STYLES_CACHE_CONTROL,
} from "../ui/constants.ts";
import {
  clearedSessionCookieHeader,
  sessionCookieHeader,
  signSessionToken,
  verifySessionToken,
} from "../ui/session.ts";
import { UI_STYLESHEET } from "../ui/styles.ts";
import {
  forbidden,
  isPostedCsrfValid,
  parseFormBody,
} from "../ui/route-helpers.tsx";
import { LoginPage } from "../ui/pages/login.tsx";
import { uiPagesRoutes } from "./ui-pages.tsx";
import type { AppDeps, AppEnv } from "../types.ts";

const MS_PER_SECOND = 1000;
const LOGIN_PATH = "/ui/login";
const FEED_PATH = "/ui/feed";

const LOGIN_FAILED_MESSAGE = "That key was not recognized.";
const LOGIN_INVALID_MESSAGE = "Enter your developer API key.";
const LOGIN_CROSS_SITE_MESSAGE = "This login request was blocked as cross-site.";

/**
 * Login has no session yet, so it cannot carry the session-bound CSRF token
 * every other POST uses. Fetch-metadata is the dependency-free stand-in: a
 * browser tags a genuine same-origin form submit `same-origin`; a cross-site
 * (or same-site) auto-submit — the request that would log a victim into the
 * ATTACKER's session — is refused. An absent header (non-browser clients, the
 * `crosscheck login` CLI, curl) is allowed: CSRF is a browser-only threat and
 * the CLI authenticates over /api, never here.
 */
const SEC_FETCH_SITE_HEADER = "sec-fetch-site";
const CROSS_ORIGIN_FETCH_SITES: ReadonlySet<string> = new Set([
  "cross-site",
  "same-site",
]);

const isCrossSiteRequest = (c: Context<AppEnv>): boolean => {
  const fetchSite = c.req.header(SEC_FETCH_SITE_HEADER);
  return fetchSite !== undefined && CROSS_ORIGIN_FETCH_SITES.has(fetchSite);
};

const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.header("Content-Security-Policy", UI_CSP);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cache-Control", "no-store");
  await next();
};

const redirectToLogin = (c: Context<AppEnv>): Response =>
  c.redirect(LOGIN_PATH, 303);

const isSecureTransport = (c: Context<AppEnv>): boolean =>
  new URL(c.req.url).protocol === "https:";

/**
 * Session middleware: valid signed cookie → the developer row it names is
 * the reader; anything else → the login page. Loading the row fresh on
 * every request keeps a session no better than its account.
 */
const uiSessionAuth = (deps: AppDeps): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const token = getCookie(c, UI_SESSION_COOKIE_NAME);
    if (token === undefined) {
      return redirectToLogin(c);
    }
    const developerId = verifySessionToken(
      deps.uiSessionSecret,
      token,
      deps.now(),
    );
    if (developerId === null) {
      return redirectToLogin(c);
    }
    const rows = await deps.db
      .select({
        id: developers.id,
        name: developers.name,
        email: developers.email,
      })
      .from(developers)
      .where(eq(developers.id, developerId))
      .limit(1);
    const developer = rows[0];
    if (developer === undefined) {
      return redirectToLogin(c);
    }
    c.set("developer", developer);
    c.set("uiSessionToken", token);
    await next();
  };
};

export const uiRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();
  router.use("*", securityHeaders);

  // Public: the stylesheet (static, secret-free) and the login exchange.
  router.get("/styles.css", (c) => {
    c.header("Cache-Control", UI_STYLES_CACHE_CONTROL);
    return c.text(UI_STYLESHEET, 200, { "Content-Type": "text/css" });
  });

  router.get("/login", (c) => c.html(<LoginPage />));

  router.post("/login", async (c) => {
    if (isCrossSiteRequest(c)) {
      return forbidden(c, LOGIN_CROSS_SITE_MESSAGE);
    }
    const body = await parseFormBody(c);
    const apiKey = body["apiKey"];
    if (
      typeof apiKey !== "string" ||
      apiKey.length === 0 ||
      apiKey.length > UI_MAX_API_KEY_FORM_CHARS
    ) {
      return c.html(<LoginPage error={LOGIN_INVALID_MESSAGE} />, 400);
    }
    const rows = await deps.db
      .select({ id: developers.id })
      .from(developers)
      .where(eq(developers.apiKeyHash, hashApiKey(apiKey)))
      .limit(1);
    const developer = rows[0];
    if (developer === undefined) {
      return c.html(<LoginPage error={LOGIN_FAILED_MESSAGE} />, 401);
    }
    const expiresAtMs =
      deps.now().getTime() + UI_SESSION_TTL_SECONDS * MS_PER_SECOND;
    const token = signSessionToken(
      deps.uiSessionSecret,
      developer.id,
      expiresAtMs,
    );
    c.header("Set-Cookie", sessionCookieHeader(token, isSecureTransport(c)));
    return c.redirect(FEED_PATH, 303);
  });

  // Everything below requires the signed session.
  router.use("*", uiSessionAuth(deps));

  router.post("/logout", async (c) => {
    if (!(await isPostedCsrfValid(c, deps))) {
      return forbidden(c, "Invalid or missing CSRF token.");
    }
    c.header("Set-Cookie", clearedSessionCookieHeader());
    return redirectToLogin(c);
  });

  router.route("/", uiPagesRoutes(deps));

  return router;
};
