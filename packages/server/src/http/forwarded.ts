/**
 * WHOSE X-FORWARDED-* HEADERS THE HUB BELIEVES (CROSSCHECK_TRUSTED_PROXIES).
 *
 * A proxy in front of the hub (`tailscale serve`, Caddy, nginx) says how the
 * browser reached it: `X-Forwarded-Proto: https`, `X-Forwarded-For: <client>`.
 * Anybody else can send the same bytes. A LAN peer that connects straight to
 * `:7100` and writes `X-Forwarded-Proto: https` would otherwise be believed,
 * and that stops being harmless the moment the header gates anything. So the
 * headers count only when the TCP peer, the socket's own other end, is:
 *
 *   - loopback. `tailscale serve` and a proxy on the hub's own machine connect
 *     from there, and on the hub's own machine nothing here is a boundary
 *     anyway (04a §12, open item 1);
 *   - or listed in CROSSCHECK_TRUSTED_PROXIES, a comma list of addresses and
 *     CIDRs. The Docker kit's Caddy is one: it is another container, so its
 *     peer address is a bridge IP, never loopback.
 *
 * From anyone else the headers are ignored, as if absent. An unknown peer
 * (http/peer.ts: null under `app.request`, or behind something that is not
 * Bun) is nobody's proxy.
 */
import { BlockList, isIP } from "node:net";
import type { Context } from "hono";

import { isLoopbackAddress } from "./peer.ts";
import type { AppDeps, AppEnv } from "../types.ts";

export const TRUSTED_PROXIES_ENV = "CROSSCHECK_TRUSTED_PROXIES";

const IPV4_MAX_PREFIX = 32;
const IPV6_MAX_PREFIX = 128;
const FORWARDED_PROTO_HEADER = "x-forwarded-proto";
const FORWARDED_HEADER_PREFIX = "x-forwarded-";
/** RFC 7239's single header, which some proxies send instead. */
const RFC7239_FORWARDED_HEADER = "forwarded";

export interface TrustedProxies {
  /** Whether a TCP peer address is one of the listed proxies. Loopback is not listed; it is always trusted. */
  readonly includes: (address: string) => boolean;
}

export const NO_TRUSTED_PROXIES: TrustedProxies = { includes: () => false };

type IpFamily = "ipv4" | "ipv6";

const familyOf = (address: string): IpFamily | null => {
  const version = isIP(address);
  if (version === 4) {
    return "ipv4";
  }
  return version === 6 ? "ipv6" : null;
};

/** `[fd7a::1]` is how people write IPv6; a zone (`%en0`) names an interface, not an address. */
const bareAddress = (text: string): string => {
  const unbracketed = text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
  const zone = unbracketed.indexOf("%");
  return zone === -1 ? unbracketed : unbracketed.slice(0, zone);
};

/** `::ffff:a.b.c.d` as the URL parser serialises it: the IPv4-mapped block. */
const IPV4_MAPPED_PATTERN = /^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/;
/** The width of the mapped prefix: a mapped CIDR this wide or wider covers every IPv4 peer. */
const IPV4_MAPPED_PREFIX = 96;

/**
 * A CIDR that trusts everybody (review of the hub hardening, L3): `0.0.0.0/0`,
 * `::/0`, or a mapped block such as `::ffff:0:0/96`, which BlockList also
 * matches against every IPv4 peer. Such an entry turns "the peer is our
 * proxy" back into "any peer", the 0.10 behaviour this setting replaced.
 */
const isTrustEveryone = (network: string, prefix: number, family: IpFamily): boolean => {
  if (prefix === 0) {
    return true;
  }
  if (family !== "ipv6") {
    return false;
  }
  const canonical = new URL(`http://[${network}]`).hostname.slice(1, -1);
  return IPV4_MAPPED_PATTERN.test(canonical) && prefix <= IPV4_MAPPED_PREFIX;
};

const refuse = (entry: string, why: string): never => {
  throw new Error(
    `${TRUSTED_PROXIES_ENV}: "${entry}" ${why}. List the proxy's address or network, for example ` +
      "172.18.0.2 or 172.18.0.0/16 for the Docker kit's Caddy",
  );
};

/**
 * `CROSSCHECK_TRUSTED_PROXIES`, read once at startup. Unset or empty means no
 * proxy beyond loopback: that only ever trusts less. A malformed entry is a
 * startup error, never a silent skip, because a skipped entry is a proxy whose
 * https the hub would then wrongly call plain http, or the reverse.
 */
export const parseTrustedProxies = (raw: string | undefined): TrustedProxies => {
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    return NO_TRUSTED_PROXIES;
  }
  const list = new BlockList();
  for (const entry of entries) {
    const [networkText = "", prefixText, ...extra] = entry.split("/");
    const network = bareAddress(networkText);
    const family = familyOf(network);
    if (family === null || extra.length > 0) {
      return refuse(entry, "is not an IP address or CIDR");
    }
    if (prefixText === undefined) {
      list.addAddress(network, family);
      continue;
    }
    const prefix = /^\d{1,3}$/.test(prefixText) ? Number(prefixText) : Number.NaN;
    const maxPrefix = family === "ipv4" ? IPV4_MAX_PREFIX : IPV6_MAX_PREFIX;
    if (!Number.isInteger(prefix) || prefix > maxPrefix) {
      return refuse(entry, `has a prefix outside 0-${String(maxPrefix)}`);
    }
    if (isTrustEveryone(network, prefix, family)) {
      return refuse(entry, "trusts every peer (or every IPv4 peer), which is what this setting exists to prevent");
    }
    list.addSubnet(network, prefix, family);
  }
  return {
    includes: (address) => {
      const bare = bareAddress(address);
      const family = familyOf(bare);
      if (family === null) {
        return false;
      }
      try {
        // An IPv4-mapped peer (`::ffff:172.18.0.2`, a dual-stack socket's
        // spelling) matches an IPv4 entry: BlockList maps it.
        return list.check(bare, family);
      } catch {
        return false;
      }
    },
  };
};

/** Whether this request's TCP peer may speak for the client through X-Forwarded-* headers. */
export const isForwardingPeerTrusted = (c: Context<AppEnv>, deps: AppDeps): boolean => {
  const peer = deps.peerAddress(c);
  return peer !== null && (isLoopbackAddress(peer) || deps.trustedProxies.includes(peer));
};

/**
 * The client-facing protocol a trusted proxy reports, lowercased, or null:
 * chained proxies append, so the first value is the browser's.
 */
export const trustedForwardedProto = (c: Context<AppEnv>, deps: AppDeps): string | null => {
  if (!isForwardingPeerTrusted(c, deps)) {
    return null;
  }
  const value = c.req.header(FORWARDED_PROTO_HEADER);
  return value === undefined ? null : (value.split(",")[0]?.trim().toLowerCase() ?? null);
};

/**
 * Whether a trusted proxy handled this request: any `X-Forwarded-*`, or RFC
 * 7239 `Forwarded`, from a peer allowed to send one. `tailscale serve` always
 * sets X-Forwarded-For.
 */
export const isTrustedProxied = (c: Context<AppEnv>, deps: AppDeps): boolean =>
  isForwardingPeerTrusted(c, deps) &&
  [...c.req.raw.headers.keys()].some(
    (name) => name.startsWith(FORWARDED_HEADER_PREFIX) || name === RFC7239_FORWARDED_HEADER,
  );
