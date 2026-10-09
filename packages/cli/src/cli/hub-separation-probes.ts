/**
 * WHERE THE HUB RUNS, AND AS WHOM, seen from the developer's own OS user.
 *
 * The default probes behind doctor's hub separation lines
 * (doctor-hub-separation.ts). Each one is bounded, and each one that cannot
 * answer says so as a value — never as an answer that reads like "separated".
 *
 *   placement   on this machine: a loopback name, one of this machine's own
 *               addresses (its tailnet IP among them), or a name that resolves
 *               to one. The hub itself speaks plain http, so an https URL on
 *               this machine is a front, and only `tailscale serve status
 *               --json` can name the loopback port behind it. Anything that
 *               resolves elsewhere is elsewhere; a name that does not resolve
 *               is unknown.
 *   listeners   who listens on the hub's local port. lsof first. Run without
 *               root it lists only this user's own sockets, on macOS and on
 *               Linux alike, so a hub that runs under its own user is
 *               invisible to it. On macOS `netstat -anv` names every
 *               listener's pid and `ps` names that pid's user; elsewhere a
 *               listener lsof cannot see stays "not checked".
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { z } from "zod";

import { runBoundedCommandOutcome } from "@crosscheck/connector-core/git/git.ts";

const DNS_TIMEOUT_MS = 1000;
const TAILSCALE_TIMEOUT_MS = 2000;
const LSOF_TIMEOUT_MS = 1500;
const NETSTAT_TIMEOUT_MS = 2000;
const PS_TIMEOUT_MS = 1000;
const MS_PER_SECOND = 1000;
const HTTPS_DEFAULT_PORT = 443;
const HTTP_DEFAULT_PORT = 80;
/** The column after `process:pid` in `netstat -anv` (5 hex digits), then `options` (8). */
const NETSTAT_PID_PATTERN = /:(\d+)\s+[0-9a-f]{5}\s+[0-9a-f]{8}(?:\s|$)/;
const NETSTAT_STATE_FIELD = 5;
const NETSTAT_LOCAL_FIELD = 3;

/** One process listening on a port: its user, and its command when the tool named it. */
export interface Listener {
  readonly uid: number;
  readonly user: string | null;
  readonly command: string | null;
}

export type ListenerLookup =
  | { readonly kind: "found"; readonly listeners: readonly Listener[] }
  | { readonly kind: "none"; readonly why: string }
  | { readonly kind: "failed"; readonly why: string };

export type CommandOutcome =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly timedOut: boolean };

/** Runs one command under a deadline. Injected so tests never run the real lsof, netstat or ps. */
export type RunCommand = (cmd: readonly string[], timeoutMs: number) => Promise<CommandOutcome>;

export const runCommand: RunCommand = (cmd, timeoutMs) => runBoundedCommandOutcome(cmd, "/", timeoutMs);

export type HubPlacement =
  | { readonly kind: "local"; readonly port: number; readonly front: "direct" | "tailscale serve" }
  | { readonly kind: "elsewhere"; readonly host: string }
  | { readonly kind: "unknown"; readonly why: string };

export interface PlacementProbes {
  /** Every address `host` resolves to, or null when it did not resolve in time. */
  readonly lookupHost: (host: string) => Promise<readonly string[] | null>;
  /** This machine's own interface addresses, lowercased. */
  readonly localAddresses: () => ReadonlySet<string>;
  /** `tailscale serve status --json`'s stdout, or null when it cannot be had. */
  readonly serveStatus: () => Promise<string | null>;
}

const seconds = (ms: number): string => `${String(ms / MS_PER_SECOND)} s`;

const bareHost = (hostname: string): string => hostname.replace(/^\[|\]$/g, "").toLowerCase();

const isLoopback = (host: string): boolean =>
  host === "localhost" ||
  host.endsWith(".localhost") ||
  host === "::1" ||
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);

const portOf = (url: URL): number =>
  url.port === "" ? (url.protocol === "https:" ? HTTPS_DEFAULT_PORT : HTTP_DEFAULT_PORT) : Number(url.port);

const parseUrl = (raw: string): URL | null => {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
};

const isThisMachine = async (host: string, probes: PlacementProbes): Promise<boolean | null> => {
  if (isLoopback(host)) {
    return true;
  }
  const addresses = isIP(host) === 0 ? await probes.lookupHost(host) : [host];
  if (addresses === null) {
    return null;
  }
  const local = probes.localAddresses();
  return addresses.some((address) => {
    const bare = address.replace(/^::ffff:/i, "").toLowerCase();
    return isLoopback(bare) || local.has(bare);
  });
};

const ServeStatusSchema = z.looseObject({
  Web: z
    .record(
      z.string(),
      z.looseObject({
        Handlers: z.record(z.string(), z.looseObject({ Proxy: z.string().optional() })).optional(),
      }),
    )
    .optional(),
});

/** The loopback port a `tailscale serve` proxy target names, or null for any other target. */
const loopbackPortOf = (proxy: string): number | null => {
  const spelled = /^\d+$/.test(proxy)
    ? `http://127.0.0.1:${proxy}`
    : proxy.includes("://")
      ? proxy
      : `http://${proxy}`;
  const url = parseUrl(spelled);
  return url !== null && url.protocol === "http:" && isLoopback(bareHost(url.hostname)) ? portOf(url) : null;
};

/** The loopback port `tailscale serve` forwards `host:port` to, or null when it names none. */
export const serveBackendPort = (stdout: string | null, host: string, port: number): number | null => {
  if (stdout === null) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return null;
  }
  const parsed = ServeStatusSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const site = `${host}:${String(port)}`;
  const entry = Object.entries(parsed.data.Web ?? {}).find(([name]) => name.toLowerCase() === site)?.[1];
  const proxy = entry?.Handlers?.["/"]?.Proxy;
  return proxy === undefined ? null : loopbackPortOf(proxy);
};

/** Where the hub at `hubUrl` runs, as far as this machine can tell. */
export const placeHub = async (hubUrl: string, probes: PlacementProbes): Promise<HubPlacement> => {
  const url = parseUrl(hubUrl);
  if (url === null) {
    return { kind: "unknown", why: "the hub URL does not parse" };
  }
  const host = bareHost(url.hostname);
  const port = portOf(url);
  const isHere = await isThisMachine(host, probes);
  if (isHere === null) {
    return { kind: "unknown", why: `${host} did not resolve, so doctor cannot tell whether the hub runs on this machine` };
  }
  if (!isHere) {
    return { kind: "elsewhere", host };
  }
  if (url.protocol !== "https:") {
    return { kind: "local", port, front: "direct" };
  }
  const backend = serveBackendPort(await probes.serveStatus(), host, port);
  return backend === null
    ? {
        kind: "unknown",
        why: "the hub is reached over https on this machine, and no `tailscale serve` mapping names the port behind it",
      }
    : { kind: "local", port: backend, front: "tailscale serve" };
};

const lookupHostBounded = async (host: string): Promise<readonly string[] | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolveDeadline) => {
    timer = setTimeout(() => {
      resolveDeadline(null);
    }, DNS_TIMEOUT_MS);
  });
  const answer = lookup(host, { all: true }).then(
    (rows) => rows.map((row) => row.address),
    () => null,
  );
  try {
    return await Promise.race([answer, deadline]);
  } finally {
    clearTimeout(timer);
  }
};

const interfaceAddresses = (): ReadonlySet<string> =>
  new Set(
    Object.values(networkInterfaces()).flatMap((rows) => (rows ?? []).map((row) => row.address.toLowerCase())),
  );

const tailscaleServeStatus = async (): Promise<string | null> => {
  const outcome = await runCommand(["tailscale", "serve", "status", "--json"], TAILSCALE_TIMEOUT_MS);
  return outcome.ok ? outcome.stdout : null;
};

export const defaultPlacementProbes = (): PlacementProbes => ({
  lookupHost: lookupHostBounded,
  localAddresses: interfaceAddresses,
  serveStatus: tailscaleServeStatus,
});

/** `lsof -F pcuL`: one block per process, each field a line led by its letter. */
export const parseLsofListeners = (stdout: string): readonly Listener[] =>
  stdout.split(/\n(?=p)/).flatMap((block) => {
    const fields = new Map(
      block
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => [line.slice(0, 1), line.slice(1)] as const),
    );
    const uid = Number.parseInt(fields.get("u") ?? "", 10);
    return fields.has("p") && Number.isSafeInteger(uid) && uid >= 0
      ? [{ uid, user: fields.get("L") ?? null, command: fields.get("c") ?? null }]
      : [];
  });

const portOfNetstatAddress = (address: string): number | null => {
  const tail = address.slice(address.lastIndexOf(".") + 1);
  return /^\d+$/.test(tail) ? Number(tail) : null;
};

/** The pids `netstat -anv -p tcp` shows listening on `port`, or null when a listener there has no readable pid. */
export const parseNetstatListenerPids = (stdout: string, port: number): readonly number[] | null => {
  const rows = stdout
    .split("\n")
    .map((line) => ({ line, fields: line.trim().split(/\s+/) }))
    .filter(
      ({ fields }) =>
        fields[0]?.startsWith("tcp") === true &&
        fields[NETSTAT_STATE_FIELD] === "LISTEN" &&
        portOfNetstatAddress(fields[NETSTAT_LOCAL_FIELD] ?? "") === port,
    );
  const pids = rows.map(({ line }) => NETSTAT_PID_PATTERN.exec(line)?.[1]);
  return pids.some((pid) => pid === undefined) ? null : [...new Set(pids.map(Number))];
};

/** `ps -o uid=,user=,ucomm=`: one process per line. */
export const parsePsListeners = (stdout: string): readonly Listener[] =>
  stdout.split("\n").flatMap((line) => {
    const [uidText, user, ...command] = line.trim().split(/\s+/);
    const uid = Number.parseInt(uidText ?? "", 10);
    return Number.isSafeInteger(uid) && uid >= 0 && user !== undefined
      ? [{ uid, user, command: command.length > 0 ? command.join(" ") : null }]
      : [];
  });

const failedRun = (tool: string, outcome: { readonly timedOut: boolean }, timeoutMs: number): ListenerLookup => ({
  kind: "failed",
  why: outcome.timedOut ? `${tool} did not answer within ${seconds(timeoutMs)}` : `${tool} failed`,
});

/** macOS: every listener's pid from netstat, and each pid's user from ps. */
const listenersOfAnyUser = async (port: number, run: RunCommand): Promise<ListenerLookup> => {
  const netstat = await run(["netstat", "-anv", "-p", "tcp"], NETSTAT_TIMEOUT_MS);
  if (!netstat.ok) {
    return failedRun("netstat", netstat, NETSTAT_TIMEOUT_MS);
  }
  const pids = parseNetstatListenerPids(netstat.stdout, port);
  if (pids === null) {
    return { kind: "failed", why: `netstat names no pid for the listener on :${String(port)}` };
  }
  if (pids.length === 0) {
    return { kind: "none", why: `nothing listens on :${String(port)}` };
  }
  const ps = await run(["ps", "-o", "uid=,user=,ucomm=", "-p", pids.join(",")], PS_TIMEOUT_MS);
  if (!ps.ok) {
    return failedRun("ps", ps, PS_TIMEOUT_MS);
  }
  const listeners = parsePsListeners(ps.stdout);
  return listeners.length > 0
    ? { kind: "found", listeners }
    : { kind: "failed", why: `ps named no user for the listener on :${String(port)}` };
};

/**
 * Who listens on `port`. A listener of this user's is found by lsof; on macOS
 * one of another user's by netstat and ps. A tool that fails or runs out of
 * time is `failed`, and so is a listener none of them can see: never `none`.
 */
export const lookupListeners = async (
  port: number,
  run: RunCommand,
  platform: NodeJS.Platform,
): Promise<ListenerLookup> => {
  const lsof = await run(["lsof", "-nP", `-iTCP:${String(port)}`, "-sTCP:LISTEN", "-FpcuL"], LSOF_TIMEOUT_MS);
  const own = lsof.ok ? parseLsofListeners(lsof.stdout) : [];
  if (own.length > 0) {
    return { kind: "found", listeners: own };
  }
  if (platform === "darwin") {
    return listenersOfAnyUser(port, run);
  }
  return !lsof.ok && lsof.timedOut
    ? failedRun("lsof", lsof, LSOF_TIMEOUT_MS)
    : {
        kind: "failed",
        why: `lsof shows no listener of yours on :${String(port)}, and here it cannot see another user's`,
      };
};
