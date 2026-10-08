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
    return (
      `${NAMER[foreign.hubSource]} names ${foreign.hubOrigin}, but your key comes from ` +
      "CROSSCHECK_API_KEY with no CROSSCHECK_HUB_URL and no login, so it is bound to no hub " +
      "and is sent nowhere"
    );
  }
  return (
    `${NAMER[foreign.hubSource]} names ${foreign.hubOrigin}, but your crosscheck key belongs to ` +
    `${foreign.keyOrigin}. The key is sent only to ${foreign.keyOrigin}, so nothing from here ` +
    "is captured or sent to either hub"
  );
};

/** The remedy for the same person, by where the foreign hub came from. */
export const foreignHubFix = (foreign: ForeignHub): string => {
  if (foreign.keyOrigin === null) {
    return "set CROSSCHECK_HUB_URL to the hub this key belongs to, or log in: crosscheck login <hubUrl>";
  }
  if (foreign.hubSource === "env") {
    return `unset CROSSCHECK_HUB_URL, or set it to ${foreign.keyOrigin}`;
  }
  if (foreign.hubSource === "login") {
    return `log in again with the hub this key belongs to: crosscheck login ${foreign.keyOrigin}`;
  }
  return (
    `if ${foreign.hubOrigin} is your team's hub under another address, log in with the ` +
    `address this repo uses (crosscheck login ${foreign.hubOrigin}), or set "hubUrl" in ` +
    `.crosscheck.json to ${foreign.keyOrigin}. If you do not recognise ${foreign.hubOrigin}, ` +
    "change nothing: a repo cannot make crosscheck send your key there"
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
  return (
    `crosscheck is not reporting from here: ${named} a different hub ${belongs}, so crosscheck ` +
    "keeps the key and captures nothing. `crosscheck doctor` names both hubs and the fix."
  );
};
