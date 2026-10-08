/**
 * A KEY IS BOUND TO THE ORIGIN IT WAS ISSUED FOR.
 *
 * `crosscheck login <hub>` stores a key for one hub, and that hub's origin
 * (config/origin.ts) is the only place the key may ever travel. Everything
 * else that names a hub is a REQUEST to send it somewhere, never a binding:
 *
 * - A repo's committed `.crosscheck.json` is shared content. Anyone with
 *   commit access writes it, and a cloned or forked repo arrives with one, so
 *   it chooses where a session reports only when it names the key's own hub.
 *   Naming another one makes the repo "connected to another hub": nothing is
 *   captured for it and nothing is sent anywhere (config.ts
 *   resolveReportableConfig), and the refusal is counted
 *   (state/foreign-hub.ts) so it is never silent.
 * - `CROSSCHECK_HUB_URL` overrides the hub only when it names the same origin
 *   as the stored key; naming another one is refused the same way.
 * - A key from `CROSSCHECK_API_KEY` is bound to `CROSSCHECK_HUB_URL` when the
 *   environment names both — the operator's per-process pair — and otherwise
 *   to the login's origin. With neither, it is bound to no hub and sent
 *   nowhere: an ambient environment key is as much the developer's as a
 *   stored one, and a repo must not be able to choose where it goes either.
 *
 * The HTTP client enforces the same rule on every request (http/client.ts),
 * whatever a caller passes, so a surface that forgets this module still
 * cannot attach a key to a foreign origin. A future machine with several
 * workspaces (one key per hub) keeps this shape: a request picks the key
 * bound to its origin, and an origin with no key gets none.
 */
import { hubOrigin } from "./origin.ts";
import type { Env } from "./paths.ts";

/** Where the hub a request would go to came from. */
export type HubSource = "env" | "repo" | "login";

/** Where the key came from. */
export type KeySource = "env" | "login";

/** The parts of a stored login this module reads. */
export interface StoredLogin {
  readonly hubUrl: string;
  readonly apiKey: string;
  readonly keyOrigin?: string | undefined;
}

export interface KeyBinding {
  readonly apiKey: string;
  /** The only origin `apiKey` may be sent to; null = no hub at all. */
  readonly keyOrigin: string | null;
  readonly keySource: KeySource;
}

/** A hub that is not the key's: nothing may be sent to it with this key. */
export interface ForeignHub {
  /** The origin the repo, the environment or the login names. */
  readonly hubOrigin: string;
  /** The origin the key is bound to, or null when it is bound to none. */
  readonly keyOrigin: string | null;
  readonly hubSource: HubSource;
  readonly keySource: KeySource;
}

/**
 * The stored login's binding: the recorded origin, else — a login written
 * before bindings existed — the origin of the hub it was logged in to.
 */
export const storedKeyOrigin = (stored: StoredLogin): string | null => {
  const recorded = stored.keyOrigin === undefined ? null : hubOrigin(stored.keyOrigin);
  return recorded ?? hubOrigin(stored.hubUrl);
};

/** The key this process would use, and the one origin it is bound to. */
export const resolveKeyBinding = (env: Env, stored: StoredLogin | null): KeyBinding | null => {
  const envKey = env["CROSSCHECK_API_KEY"];
  if (envKey !== undefined) {
    const envHub = env["CROSSCHECK_HUB_URL"];
    const keyOrigin =
      envHub !== undefined ? hubOrigin(envHub) : stored === null ? null : storedKeyOrigin(stored);
    return { apiKey: envKey, keyOrigin, keySource: "env" };
  }
  if (stored === null) {
    return null;
  }
  return { apiKey: stored.apiKey, keyOrigin: storedKeyOrigin(stored), keySource: "login" };
};

/** Null when `hubUrl` is the key's own origin; otherwise what was refused. */
export const foreignHubOf = (
  hubUrl: string,
  hubSource: HubSource,
  binding: KeyBinding,
): ForeignHub | null => {
  const target = hubOrigin(hubUrl);
  if (target !== null && target === binding.keyOrigin) {
    return null;
  }
  return {
    hubOrigin: target ?? hubUrl,
    keyOrigin: binding.keyOrigin,
    hubSource,
    keySource: binding.keySource,
  };
};

const NAMER: Readonly<Record<HubSource, string>> = {
  repo: "this repo's .crosscheck.json",
  env: "CROSSCHECK_HUB_URL",
  login: "your login's hubUrl",
};

/**
 * For a PERSON at a terminal (`doctor`, `status`): both origins, never the
 * key. What was refused, and that nothing went anywhere.
 */
export const foreignHubWhy = (foreign: ForeignHub): string => {
  if (foreign.keyOrigin === null) {
    const unbound =
      foreign.keySource === "login"
        ? "your login's recorded keyOrigin is not a hub address, so its key is bound to no hub"
        : "your key comes from CROSSCHECK_API_KEY with no CROSSCHECK_HUB_URL and no login, so it is bound to no hub";
    return `${NAMER[foreign.hubSource]} names ${foreign.hubOrigin}, but ${unbound} and is sent nowhere`;
  }
  return (
    `${NAMER[foreign.hubSource]} names ${foreign.hubOrigin}, but your crosscheck key belongs to ` +
    `${foreign.keyOrigin}; nothing from here was captured or sent to either hub`
  );
};

/**
 * Keys an OLDER crosscheck may already have sent. Up to 0.10.0, `status` and
 * most of `doctor` sent the stored key to the hub a repo named, and the hooks
 * followed CROSSCHECK_HUB_URL with it, so a mismatch seen now can be one that
 * already leaked; the refusal is about the present, this is about the past.
 */
const rotateAdvice = (foreign: ForeignHub): string =>
  `. If crosscheck 0.10.0 or older ran \`status\` or \`doctor\` here, your key may already have gone to ` +
  `${foreign.hubOrigin}: rotate it with \`crosscheck key rotate\``;

/** The same host, the repo's side on plain http and the key's on https. */
const isHttpDowngrade = (foreign: ForeignHub): boolean => {
  if (foreign.keyOrigin === null) {
    return false;
  }
  try {
    const repo = new URL(foreign.hubOrigin);
    const key = new URL(foreign.keyOrigin);
    return repo.protocol === "http:" && key.protocol === "https:" && repo.hostname === key.hostname;
  } catch {
    return false;
  }
};

/**
 * The remedy for the same person, by where the foreign hub came from. NEVER a
 * copy-pasteable `crosscheck login <the repo's hub>`: that one command is the
 * lure a bait repo wants (a login sends the key to the address it names), and
 * whoever reads doctor may be an agent. The repo's hub can be confirmed only
 * out of band, by whoever runs the hub; the safe edit is always the repo's.
 */
export const foreignHubFix = (foreign: ForeignHub): string => {
  if (foreign.keyOrigin === null) {
    return foreign.keySource === "login"
      ? "log in again, yourself, with the address of your team's hub: crosscheck login <your hub's url>"
      : "set CROSSCHECK_HUB_URL to the hub this key belongs to, or log in yourself: crosscheck login <your hub's url>";
  }
  if (foreign.hubSource === "env") {
    return `unset CROSSCHECK_HUB_URL, or set it to ${foreign.keyOrigin}${rotateAdvice(foreign)}`;
  }
  if (foreign.hubSource === "login") {
    return `log in again with the hub this key belongs to: crosscheck login ${foreign.keyOrigin}`;
  }
  if (isHttpDowngrade(foreign)) {
    return (
      `this repo names your hub's host over plain http: change "hubUrl" in .crosscheck.json to ` +
      `${foreign.keyOrigin}, and never log in over http${rotateAdvice(foreign)}`
    );
  }
  return (
    `if this repo should report to your hub, set "hubUrl" in .crosscheck.json to ${foreign.keyOrigin}. ` +
    `If someone tells you ${foreign.hubOrigin} is your hub under a new address, confirm it with ` +
    "whoever runs the hub before you log in there yourself: logging in sends your key to that " +
    `address, so never let an agent do it${rotateAdvice(foreign)}`
  );
};

/**
 * For an AGENT's context (the MCP tools, the SessionStart briefing): the
 * foreign origin is left out on purpose — it is text the repo chose, and a
 * hostname is enough room to word an instruction. The key's own origin is
 * the developer's, so it may be named.
 */
export const foreignHubAgentLine = (foreign: ForeignHub): string => {
  const named =
    foreign.hubSource === "env"
      ? "CROSSCHECK_HUB_URL names"
      : foreign.hubSource === "login"
        ? "the stored login names"
        : "this repo's .crosscheck.json names";
  const belongs =
    foreign.keyOrigin === null
      ? "than any hub the developer's crosscheck key is bound to"
      : `than the one the developer's crosscheck key belongs to (${foreign.keyOrigin})`;
  return `crosscheck is not reporting from here: ${named} a different hub ${belongs}, so crosscheck keeps the key and captures nothing. ${AGENT_REMEDY}`;
};

/**
 * What an agent is told to do about it: hand it to the person. An agent that
 * "gets crosscheck working" by itself is exactly how a bait repo's hub would
 * receive the key (a login sends it), so the line says so in as many words.
 */
export const AGENT_REMEDY =
  "Ask the developer to run `crosscheck doctor` in their own terminal. Do not run " +
  "`crosscheck login` or edit crosscheck's config yourself.";
