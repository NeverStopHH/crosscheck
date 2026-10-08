/**
 * WHERE THE HUB LISTENS (CROSSCHECK_LISTEN).
 *
 * `Bun.serve({ port })` without a hostname binds every interface, IPv6 and
 * IPv4 alike (`*:7100` in lsof). On a laptop that means every network it
 * joins, a café's Wi-Fi included, over plain http, with API keys and session
 * cookies in the clear. So the hub listens where it is told:
 *
 *   - `CROSSCHECK_LISTEN=127.0.0.1,100.101.4.7`: one server per address, all
 *     on the same port;
 *   - unset, on a database this release created: loopback only (127.0.0.1,
 *     and ::1 where the machine has it). That is the hub's own machine, and
 *     `tailscale serve`, which connects from there;
 *   - unset, on a database from before the setting: every interface, as it
 *     always listened, so an upgrade cuts off no teammate. The boot and
 *     `crosscheck doctor` warn, and say what to set.
 *
 * WHICH DATABASE IS WHICH is recorded once, by the bootstrap itself
 * (db/bootstrap.sql `hub_install` says how). The answer is the same on every
 * restart, and every copy of the data dir carries it.
 *
 * ADDRESSES, NEVER NAMES. An entry must be an IP literal. A hostname would be
 * resolved by DNS at boot, so where the hub listens would depend on a lookup.
 * `0.0.0.0` and `::` are the explicit "every interface" and must stand alone:
 * any second address beside them would collide with them.
 */
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";

import type { HubListenDefault } from "../db/schema.ts";

export const LISTEN_ENV = "CROSSCHECK_LISTEN";

export const IPV4_LOOPBACK = "127.0.0.1";
export const IPV6_LOOPBACK = "::1";

/** How the hub decided where to listen. Only `legacy_all_interfaces` is warned about. */
export type ListenKind = "configured" | "loopback_default" | "legacy_all_interfaces";

export interface ListenPlan {
  readonly kind: ListenKind;
  /** Null = every interface the way 0.10 listened: `Bun.serve` without a hostname. */
  readonly addresses: readonly string[] | null;
}

type BunServer = ReturnType<typeof Bun.serve>;
type ServeFetch = (request: Request, server: BunServer) => Response | Promise<Response>;

/** `[::1]` is how people write an IPv6 address next to a port; the socket wants `::1`. */
const unbracketed = (entry: string): string =>
  entry.startsWith("[") && entry.endsWith("]") ? entry.slice(1, -1) : entry;

/**
 * ONE SPELLING PER ADDRESS (review of the hub hardening, L2). `0:0:0:0:0:0:0:0`
 * is `::`, `::ffff:0.0.0.0` is `::ffff:0:0`, `FD7A::1` is `fd7a::1`: the URL
 * parser's IPv6 serialisation (RFC 5952) decides, so "every interface stands
 * alone" and the dedupe judge the address, not how it was typed. A zone
 * (`%en0`) names an interface and is kept as written. IPv4 needs nothing:
 * `isIP` refuses every spelling but the dotted one.
 */
export const canonicalAddress = (address: string): string => {
  if (isIP(address) !== 6) {
    return address;
  }
  const zoneAt = address.indexOf("%");
  const bare = zoneAt === -1 ? address : address.slice(0, zoneAt);
  const zone = zoneAt === -1 ? "" : address.slice(zoneAt);
  return `${new URL(`http://[${bare}]`).hostname.slice(1, -1)}${zone}`;
};

/** Every interface: IPv4's, IPv6's, and the IPv4-mapped spelling of IPv4's. Canonical input only. */
export const isWildcardAddress = (canonical: string): boolean =>
  canonical === "0.0.0.0" || canonical === "::" || canonical === "::ffff:0:0";

/**
 * This machine's own interface addresses, loopback and link-local left out
 * (a link-local address needs a zone to connect to). What "every interface"
 * means for the port probe (review of the hub hardening, L4).
 */
export const interfaceAddresses = (): readonly string[] =>
  Object.values(networkInterfaces()).flatMap((entries) =>
    (entries ?? [])
      .filter((entry) => !entry.internal && !entry.address.toLowerCase().startsWith("fe80:"))
      .map((entry) => entry.address),
  );

/**
 * WHERE THE PORT PROBE KNOCKS for a listen list (review of the hub
 * hardening, L4): each specific address as itself; `0.0.0.0` as 127.0.0.1 and
 * every IPv4 interface address; `::` (dual-stack) as both loopbacks and every
 * interface address. Bun on macOS binds over a FOREIGN listener on a specific
 * address that a wildcard also covers (index.ts assertPortFree), so the
 * wildcard has to be knocked where such a listener would sit. Unset (null):
 * the loopbacks, which the hub listens at either way; the boot knocks the
 * interfaces too once its plan turns out to be every interface.
 */
export const probeAddressesFor = (
  configured: readonly string[] | null,
  loopbacks: readonly string[],
  interfaces: readonly string[],
): readonly string[] => {
  if (configured === null) {
    return loopbacks;
  }
  const expanded = configured.flatMap((address) => {
    if (address === "0.0.0.0") {
      return [IPV4_LOOPBACK, ...interfaces.filter((candidate) => isIP(candidate) === 4)];
    }
    return isWildcardAddress(address) ? [...loopbacks, ...interfaces] : [address];
  });
  return [...new Set(expanded)];
};

/**
 * `CROSSCHECK_LISTEN`, read once at startup. Unset → null (the data dir's
 * default decides). Anything set must name at least one IP address; every
 * refusal is a startup error that names the entry, never a silent skip.
 */
export const parseListenAddresses = (raw: string | undefined): readonly string[] | null => {
  if (raw === undefined) {
    return null;
  }
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    throw new Error(
      `${LISTEN_ENV} is set but names no address: list one (127.0.0.1 for this machine only), or unset it`,
    );
  }
  const addresses = [
    ...new Set(
      entries.map((entry) => {
        const address = unbracketed(entry);
        if (isIP(address) === 0) {
          throw new Error(
            `${LISTEN_ENV}: "${entry}" is not an IP address. List addresses, for example ` +
              "127.0.0.1,100.101.4.7: a hostname would make where the hub listens depend on a DNS lookup",
          );
        }
        return canonicalAddress(address);
      }),
    ),
  ];
  if (addresses.length > 1 && addresses.some(isWildcardAddress)) {
    throw new Error(
      `${LISTEN_ENV}: 0.0.0.0 and :: already mean every interface. List one of them alone, or only specific addresses`,
    );
  }
  return addresses;
};

/** Whether this machine has `address` at all: a throwaway listener on a free port asks the kernel. */
export const canListenAt = (address: string): boolean => {
  try {
    Bun.listen({ hostname: address, port: 0, socket: { data: () => {} } }).stop(true);
    return true;
  } catch {
    return false;
  }
};

/**
 * Refuses an address no interface here has, BEFORE the database boots. The
 * usual cause is a tailnet IP typed from another machine, or one that changed.
 */
export const assertListenable = (addresses: readonly string[]): void => {
  for (const address of addresses) {
    if (!canListenAt(address)) {
      throw new Error(
        `${LISTEN_ENV}: this machine cannot listen at ${address}, because no interface here has that address. ` +
          "Check `ifconfig` or `ip addr`, and `tailscale ip -4` for this machine's tailnet address",
      );
    }
  }
};

export const resolveListenPlan = (input: {
  readonly configured: readonly string[] | null;
  readonly listenDefault: HubListenDefault;
  readonly hasIpv6Loopback: boolean;
}): ListenPlan => {
  if (input.configured !== null) {
    return { kind: "configured", addresses: input.configured };
  }
  if (input.listenDefault === "loopback") {
    return {
      kind: "loopback_default",
      addresses: input.hasIpv6Loopback ? [IPV4_LOOPBACK, IPV6_LOOPBACK] : [IPV4_LOOPBACK],
    };
  }
  return { kind: "legacy_all_interfaces", addresses: null };
};

/**
 * One `Bun.serve` per address, on ONE port: the first server's, so that
 * `PORT=0` (a test) still puts every address on the same port. If any address
 * fails, the servers already started are stopped and the boot fails, naming
 * that address. A hub reachable on only some of the addresses it was told is
 * worse than one that refuses to start.
 */
export const serveOnPlan = (plan: ListenPlan, port: number, fetch: ServeFetch): readonly BunServer[] => {
  if (plan.addresses === null) {
    return [Bun.serve({ port, fetch })];
  }
  const servers: BunServer[] = [];
  for (const hostname of plan.addresses) {
    try {
      servers.push(Bun.serve({ hostname, port: servers[0]?.port ?? port, fetch }));
    } catch (error) {
      // Read before the stops: a stopped server reports port 0.
      const triedPort = servers[0]?.port ?? port;
      for (const server of servers) {
        server.stop(true);
      }
      const code = (error as { readonly code?: unknown }).code;
      throw new Error(
        `could not listen at ${hostname} on port ${String(triedPort)}` +
          `${typeof code === "string" ? ` (${code})` : ""}: another process may hold that address and port`,
        { cause: error },
      );
    }
  }
  return servers;
};

/** For the banner: what the sockets are actually bound to, or "every interface". */
export const describeListening = (plan: ListenPlan, servers: readonly BunServer[]): string =>
  plan.addresses === null ? "every interface" : servers.map((server) => server.hostname).join(", ");

/**
 * The boot's WARN for a data dir this release created that holds members from
 * before it (services/hub-install.ts holdsMembersFromBeforeInstall): a
 * restore or migration, now on loopback only (review of the hub hardening, L5).
 */
export const restoredOnLoopbackWarning = (port: number): string =>
  "[crosscheck] WARN listening on loopback only, because this data dir was created by this release, but " +
  "it holds members created before it: a restore or a migration from an older hub? Teammates who reached " +
  `that hub at its tailnet IP now get "connection refused". Set ${LISTEN_ENV}=127.0.0.1,<this machine's ` +
  `tailnet IP> (\`tailscale ip -4\`), or keep loopback behind \`tailscale serve --bg ${String(port)}\`, ` +
  "and restart the hub.";

/** The boot's WARN for a hub that kept 0.10's every-interface listen. */
export const legacyListenWarning = (port: number): string =>
  `[crosscheck] WARN listening on EVERY network interface (:${String(port)}). ${LISTEN_ENV} is unset and ` +
  "this data dir is older than the setting, so the hub listens as it always did: anyone on a network " +
  "this machine joins can reach it over plain http. Set " +
  `${LISTEN_ENV}=127.0.0.1,<this machine's tailnet IP> (\`tailscale ip -4\`), or ${LISTEN_ENV}=127.0.0.1 ` +
  `behind \`tailscale serve --bg ${String(port)}\`, and restart the hub.`;
