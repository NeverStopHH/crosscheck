/**
 * What test/network-guard.ts refuses, as data and one pure predicate — split
 * from the preload so test/network-guard.test.ts can read the rules WITHOUT
 * installing the guard itself: a test that imported the preload would install
 * it on import and could never notice a bunfig that lost it.
 */

/** The port a real hub listens on by default (server src/constants.ts DEFAULT_PORT). */
const REAL_HUB_PORT = "7100";

/** Every spelling of this machine a URL can carry. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]", "0.0.0.0"]);

/** Tailscale's MagicDNS suffix: every team hub reachable over the tailnet. */
const TAILNET_SUFFIX = ".ts.net";

/** Where the refusals are counted, so a test can prove a request reached the guard. */
export const BLOCKED_FETCHES_KEY = Symbol.for("crosscheck.test.blockedFetches");

/** Set by the preload once the guard wraps `fetch` for this run. */
export const GUARD_INSTALLED_KEY = Symbol.for("crosscheck.test.networkGuardInstalled");

export interface GuardMarks {
  [BLOCKED_FETCHES_KEY]?: number;
  [GUARD_INSTALLED_KEY]?: boolean;
}

/** Whether a request to this URL could reach a real hub. */
export const isRealHubUrl = (url: URL): boolean => {
  const host = url.hostname.toLowerCase();
  return host.endsWith(TAILNET_SUFFIX) || (LOOPBACK_HOSTS.has(host) && url.port === REAL_HUB_PORT);
};
