/**
 * Signed UI session tokens (task item 2) and the CSRF tokens derived from
 * them (task item 6).
 *
 * TOKEN SHAPE: `<developerId>.<expiresAtMs>.<nonce>.<hmacHex>` where the
 * HMAC-SHA256 signature covers `<developerId>.<expiresAtMs>.<nonce>`. Parsing
 * splits from the RIGHT, so a developer id containing dots cannot shift the
 * fields. The cookie never carries the API key — the exchange happens once at
 * login and the key is never echoed or stored afterwards.
 *
 * ONE SESSION PER LOGIN (review L1, probe P7). The nonce is 16 bytes from the
 * CSPRNG, never the clock: without it two logins in one millisecond were the
 * same session, and an agent logging in with the person's key at that instant
 * shared — and could evict — the person's confirmation batches.
 *
 * SIGNING SECRET AND ROTATION: the secret lives in process memory only,
 * generated fresh at hub start unless CROSSCHECK_UI_SECRET is set (index.ts).
 * Nothing secret is at rest, and rotation is a hub restart (or changing the
 * env var): every outstanding session dies with the old secret and each
 * developer logs in again with their API key. That trade — re-login after
 * restart in exchange for no persisted secret — fits a hub that restarts
 * rarely and holds other people's claims.
 *
 * BOUND TO THE KEY IT WAS MINTED WITH. The signature covers the payload AND
 * the developer's current api-key hash, which the token never carries. So a
 * key rotation (routes/keys.ts, the admin route) ends every web session the
 * old key opened, without a revocation list: the hash changed, and a cookie
 * signed over the old one no longer verifies. A leaked key that somebody used
 * to log in stops working in the browser the moment it is rotated.
 *
 * CSRF: the token is HMAC(secret, "csrf." + sessionToken) — deterministic
 * per session, storable nowhere, verifiable anywhere the secret is. Forms
 * carry it as a hidden `_csrf` input; every state-changing POST checks it
 * on top of SameSite=Strict.
 */
import { createHmac, randomBytes } from "node:crypto";

import { isTokenEqual } from "../auth/keys.ts";
import { UI_SESSION_COOKIE_NAME, UI_SESSION_TTL_SECONDS } from "./constants.ts";

const TOKEN_SEPARATOR = ".";
const CSRF_CONTEXT_PREFIX = "csrf.";
/** The session nonce's size: 128 bits from the CSPRNG (review L1). */
const SESSION_NONCE_BYTES = 16;

const hmacHex = (secret: string, payload: string): string =>
  createHmac("sha256", secret).update(payload).digest("hex");

/** What the signature covers: the visible payload, and the key it was minted with. */
const signedPayload = (payload: string, apiKeyHash: string): string =>
  `${payload}\n${apiKeyHash}`;

export const signSessionToken = (
  secret: string,
  developerId: string,
  expiresAtMs: number,
  apiKeyHash: string,
): string => {
  const nonce = randomBytes(SESSION_NONCE_BYTES).toString("hex");
  const payload = [developerId, String(expiresAtMs), nonce].join(TOKEN_SEPARATOR);
  return `${payload}${TOKEN_SEPARATOR}${hmacHex(secret, signedPayload(payload, apiKeyHash))}`;
};

interface SessionPayload {
  readonly developerId: string;
  readonly expiresAtMs: number;
}

/** `<developerId>.<expiresAtMs>.<nonce>`, split from the right; null for any other shape. */
const splitPayload = (payload: string): SessionPayload | null => {
  const nonceDot = payload.lastIndexOf(TOKEN_SEPARATOR);
  if (nonceDot <= 0 || nonceDot === payload.length - 1) {
    return null;
  }
  const head = payload.slice(0, nonceDot);
  const expiresDot = head.lastIndexOf(TOKEN_SEPARATOR);
  if (expiresDot <= 0) {
    return null;
  }
  return { developerId: head.slice(0, expiresDot), expiresAtMs: Number.parseInt(head.slice(expiresDot + 1), 10) };
};

/**
 * The developer id a token CLAIMS, unverified — only so the caller can load
 * that developer's current key hash and then verify. Never an identity on
 * its own.
 */
export const claimedSessionDeveloper = (token: string): string | null => {
  const lastDot = token.lastIndexOf(TOKEN_SEPARATOR);
  const parts = lastDot <= 0 ? null : splitPayload(token.slice(0, lastDot));
  return parts === null || parts.developerId.length === 0 ? null : parts.developerId;
};

/**
 * The developer id inside a valid, unexpired token — or null. The signature
 * check runs through the same timing-safe digest comparison as API keys.
 */
export const verifySessionToken = (
  secret: string,
  token: string,
  now: Date,
  apiKeyHash: string,
): string | null => {
  const lastDot = token.lastIndexOf(TOKEN_SEPARATOR);
  if (lastDot <= 0) {
    return null;
  }
  const payload = token.slice(0, lastDot);
  const presentedSignature = token.slice(lastDot + 1);
  if (!isTokenEqual(presentedSignature, hmacHex(secret, signedPayload(payload, apiKeyHash)))) {
    return null;
  }
  const parts = splitPayload(payload);
  if (parts === null || !Number.isFinite(parts.expiresAtMs) || now.getTime() >= parts.expiresAtMs) {
    return null;
  }
  return parts.developerId.length === 0 ? null : parts.developerId;
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
