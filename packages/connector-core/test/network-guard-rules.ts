/**
 * What test/network-guard.ts refuses, as data and pure predicates — split
 * from the preload so test/network-guard.test.ts can read the rules WITHOUT
 * installing the guard itself: a test that imported the preload would install
 * it on import and could never notice a bunfig that lost it.
 */

/** The port a real hub listens on by default (server src/constants.ts DEFAULT_PORT). */
const REAL_HUB_PORT = "7100";

/** Tailscale's MagicDNS suffix: every team hub reachable over the tailnet. */
const TAILNET_SUFFIX = ".ts.net";

/** Tailscale's IPv6 range, fd7a:115c:a1e0::/48, as a normalised host starts. */
const TAILNET_IPV6_PREFIX = "fd7a:115c:a1e0:";

/** Tailscale's IPv4 range is the CGNAT block 100.64.0.0/10: second octets 64 to 127. */
const TAILNET_IPV4_FIRST = 100;
const TAILNET_IPV4_SECOND_LOW = 64;
const TAILNET_IPV4_SECOND_HIGH = 127;

/** The loopback /8: every 127.x.y.z reaches this machine. */
const LOOPBACK_IPV4_FIRST = 127;

/** Where the refusals are counted, so a test can prove a request reached the guard. */
export const BLOCKED_FETCHES_KEY = Symbol.for("crosscheck.test.blockedFetches");

/** Set by the preload once the guard wraps `fetch` for this run. */
export const GUARD_INSTALLED_KEY = Symbol.for("crosscheck.test.networkGuardInstalled");

export interface GuardMarks {
  [BLOCKED_FETCHES_KEY]?: number;
  [GUARD_INSTALLED_KEY]?: boolean;
}

/**
 * The variables that point a process at a hub, its credentials or its
 * archive. A developer's shell may export any of them; a test runner deletes
 * them at preload (round 3, F-M3), so no child spawned with `{...process.env}`
 * inherits them — the installed SessionStart hook of an e2e test would report
 * to the real hub, and a second `crosscheck serve` would boot on the real
 * archive directory.
 */
export const HUB_ENV_KEYS: readonly string[] = [
  "CROSSCHECK_HUB_URL",
  "CROSSCHECK_API_KEY",
  "CROSSCHECK_CI_TOKEN",
  "CROSSCHECK_DATA_DIR",
];

/**
 * Set in process.env by the preload of the run that started first, and so
 * inherited by every child it spawns with that env: a child that finds it
 * keeps the env it was handed — a test hub's URL among it — and only installs
 * the fetch guard.
 */
export const GUARD_CHILD_ENV = "CROSSCHECK_TEST_NETWORK_GUARD";

/**
 * `BUN_OPTIONS` with the guard preloaded, in the EQUALS form: the space form
 * breaks `bun run` and `bun test` on Bun 1.3.13 (review round 3). Every bun
 * child spawned with this env loads the guard before its own entry.
 */
export const withGuardPreload = (bunOptions: string | undefined, guardPath: string): string => {
  const flag = `--preload=${guardPath}`;
  const current = bunOptions?.trim() ?? "";
  if (current.split(/\s+/u).includes(flag)) {
    return current;
  }
  return current.length === 0 ? flag : `${current} ${flag}`;
};

const ipv4Octets = (host: string): readonly number[] | null => {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  return match === null ? null : match.slice(1).map(Number);
};

/** An IPv4-mapped IPv6 address as its IPv4 — `::ffff:7f00:1` is how URL spells `::ffff:127.0.0.1`. */
const mappedIpv4 = (bare: string): string | null => {
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(bare);
  if (hex !== null) {
    const high = Number.parseInt(hex[1] ?? "", 16);
    const low = Number.parseInt(hex[2] ?? "", 16);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
  }
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(bare);
  return dotted === null ? null : (dotted[1] ?? null);
};

/**
 * The host a resolver dials (round 3, F-M3): lowercased, without IPv6
 * brackets, without the trailing dot of a fully qualified name (`localhost.`
 * and `hub.ts.net.` reach the same machines as the names without it), and an
 * IPv4-mapped IPv6 address as its IPv4. URL itself already folds `127.1`,
 * `2130706433` and `0x7f000001` into `127.0.0.1`.
 */
export const normalisedHost = (hostname: string): string => {
  const lower = hostname.toLowerCase();
  const bare = lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower.replace(/\.$/u, "");
  return mappedIpv4(bare) ?? bare;
};

/** Whether a normalised host is this machine: localhost and its subdomains, the loopback /8, `::1`, and the any-addresses. */
const isLoopback = (host: string): boolean => {
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "::") {
    return true;
  }
  const octets = ipv4Octets(host);
  return octets !== null && (octets[0] === LOOPBACK_IPV4_FIRST || octets.every((octet) => octet === 0));
};

/** Whether a normalised host is on a tailnet: a MagicDNS name, or an address in Tailscale's IPv4 or IPv6 range. */
const isTailnet = (host: string): boolean => {
  if (host.endsWith(TAILNET_SUFFIX) || host.startsWith(TAILNET_IPV6_PREFIX)) {
    return true;
  }
  const [first, second] = ipv4Octets(host) ?? [];
  return (
    first === TAILNET_IPV4_FIRST &&
    second !== undefined &&
    second >= TAILNET_IPV4_SECOND_LOW &&
    second <= TAILNET_IPV4_SECOND_HIGH
  );
};

/**
 * Whether a request to this URL could reach a real hub: any tailnet host, or
 * this machine on the real hub's port. A bare MagicDNS name (`hub`, no
 * suffix) no pattern can tell from any other host — the env scrub is what
 * keeps a test from being handed one.
 */
export const isRealHubUrl = (url: URL): boolean => {
  const host = normalisedHost(url.hostname);
  return isTailnet(host) || (isLoopback(host) && url.port === REAL_HUB_PORT);
};
