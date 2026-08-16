/**
 * Signed UI session tokens (task item 2) and the CSRF tokens derived from
 * them (task item 6).
 *
 * TOKEN SHAPE: `<developerId>.<expiresAtMs>.<hmacHex>` where the HMAC-SHA256
 * signature covers `<developerId>.<expiresAtMs>`. Parsing splits from the
 * RIGHT, so a developer id containing dots cannot shift the fields. The
 * cookie never carries the API key — the exchange happens once at login and
 * the key is never echoed or stored afterwards.
 *
 * SIGNING SECRET AND ROTATION: the secret lives in process memory only,
 * generated fresh at hub start unless CROSSCHECK_UI_SECRET is set (index.ts).
 * Nothing secret is at rest, and rotation is a hub restart (or changing the
 * env var): every outstanding session dies with the old secret and each
 * developer logs in again with their API key. That trade — re-login after
 * restart in exchange for no persisted secret — fits a hub that restarts
 * rarely and holds other people's claims.
 *
 * CSRF: the token is HMAC(secret, "csrf." + sessionToken) — deterministic
 * per session, storable nowhere, verifiable anywhere the secret is. Forms
 * carry it as a hidden `_csrf` input; every state-changing POST checks it
 * on top of SameSite=Strict.
 */
import { createHmac } from "node:crypto";

import { isTokenEqual } from "../auth/keys.ts";
import { UI_SESSION_COOKIE_NAME, UI_SESSION_TTL_SECONDS } from "./constants.ts";

const TOKEN_SEPARATOR = ".";
const CSRF_CONTEXT_PREFIX = "csrf.";

const hmacHex = (secret: string, payload: string): string =>
  createHmac("sha256", secret).update(payload).digest("hex");

export const signSessionToken = (
  secret: string,
  developerId: string,
  expiresAtMs: number,
): string => {
  const payload = `${developerId}${TOKEN_SEPARATOR}${String(expiresAtMs)}`;
  return `${payload}${TOKEN_SEPARATOR}${hmacHex(secret, payload)}`;
};

/**
 * The developer id inside a valid, unexpired token — or null. The signature
 * check runs through the same timing-safe digest comparison as API keys.
 */
export const verifySessionToken = (
  secret: string,
  token: string,
  now: Date,
): string | null => {
  const lastDot = token.lastIndexOf(TOKEN_SEPARATOR);
  if (lastDot <= 0) {
    return null;
  }
  const payload = token.slice(0, lastDot);
  const presentedSignature = token.slice(lastDot + 1);
  if (!isTokenEqual(presentedSignature, hmacHex(secret, payload))) {
    return null;
  }
  const expiresDot = payload.lastIndexOf(TOKEN_SEPARATOR);
  if (expiresDot <= 0) {
    return null;
  }
  const developerId = payload.slice(0, expiresDot);
  const expiresAtMs = Number.parseInt(payload.slice(expiresDot + 1), 10);
  if (!Number.isFinite(expiresAtMs) || now.getTime() >= expiresAtMs) {
    return null;
  }
  return developerId.length === 0 ? null : developerId;
};

export const csrfTokenFor = (secret: string, sessionToken: string): string =>
  hmacHex(secret, `${CSRF_CONTEXT_PREFIX}${sessionToken}`);

export const isCsrfValid = (
  secret: string,
  sessionToken: string,
  presented: string,
): boolean =>
  presented.length > 0 &&
  isTokenEqual(presented, csrfTokenFor(secret, sessionToken));

const COOKIE_ATTRIBUTES = "HttpOnly; SameSite=Strict; Path=/ui";

/**
 * The session Set-Cookie value. `Secure` rides along when the browser
 * reached the hub over https — the hub terminating TLS itself, or a proxy /
 * Tailscale serve in front of it announcing `X-Forwarded-Proto: https`
 * (routes/ui.tsx isSecureTransport). Only the proxyless plain-HTTP LAN
 * install stays non-Secure: hard-coding the flag would strand it at the
 * login page, because its cookie would never be sent back.
 */
export const sessionCookieHeader = (
  token: string,
  isSecureTransport: boolean,
): string =>
  `${UI_SESSION_COOKIE_NAME}=${token}; ${COOKIE_ATTRIBUTES}; ` +
  `Max-Age=${String(UI_SESSION_TTL_SECONDS)}${isSecureTransport ? "; Secure" : ""}`;

/** Logout: same attributes, empty value, Max-Age=0. */
export const clearedSessionCookieHeader = (): string =>
  `${UI_SESSION_COOKIE_NAME}=; ${COOKIE_ATTRIBUTES}; Max-Age=0`;
