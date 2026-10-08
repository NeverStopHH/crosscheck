/**
 * Hub URLs and the ORIGIN a key is bound to (config/key-binding.ts).
 *
 * An origin is scheme + host + port, compared the way a browser compares
 * them: `new URL(...).origin` lowercases the scheme and the host, drops a
 * default port (`:80` on http, `:443` on https) and ignores user info, path,
 * query and a trailing slash. Nothing else is folded: a tailnet name and the
 * IP it resolves to are two origins, http and https are two origins, and so
 * are `host` and `host.` — a key bound to one is never sent to the other,
 * because nothing on this machine can prove they are the same hub.
 */

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/** Normalizes to a canonical origin+path with no trailing slash, or null. */
export const normalizeHubUrl = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
      return null;
    }
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
  } catch {
    return null;
  }
};

/**
 * The scheme+host+port a bearer key is safe to travel to, or null. A bearer
 * token issued by `crosscheck login <hub>` is bound to that hub's ORIGIN
 * (path is not a credential boundary), so this is what every comparison
 * between a key's binding and a request's destination goes through.
 */
export const hubOrigin = (raw: string): string | null => {
  const normalized = normalizeHubUrl(raw);
  if (normalized === null) {
    return null;
  }
  try {
    return new URL(normalized).origin;
  } catch {
    return null;
  }
};

/** True only when both parse and name the same origin; null never matches. */
export const isSameOrigin = (a: string | null, b: string | null): boolean => {
  if (a === null || b === null) {
    return false;
  }
  const left = hubOrigin(a);
  return left !== null && left === hubOrigin(b);
};
