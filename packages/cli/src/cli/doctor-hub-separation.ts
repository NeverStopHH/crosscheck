/**
 * AGENT CREDENTIAL ≠ OPERATOR AUTHORITY: does that hold on this machine?
 *
 * A hub that runs as the developer's own OS user hands every coding agent the
 * developer starts its operator token, its database and its code. These lines
 * check, as the developer, what the developer's user can reach:
 *
 *   operator token    FAIL when `hub.env` in the default hub home
 *                     (~/.crosscheck-hub) is readable or writable by this
 *                     user, or belongs to it, or when ADMIN_TOKEN sits in
 *                     this shell's environment. Tested with stat and
 *                     access(): the file is never opened.
 *   hub state         WARN when anything else of the hub's — the data dir and
 *                     its state dir, backups, trial-keys.txt, logs, and the
 *                     dirs CROSSCHECK_DATA_DIR / CROSSCHECK_STATE_DIR name in
 *                     this environment — is readable, writable or owned here.
 *   hub process       WARN when the process listening for this developer's hub
 *                     runs as this user; PASS when the hub's bun runs as
 *                     another. Only for a hub on this machine (loopback, an
 *                     address of this machine, a `tailscale serve` front);
 *                     anything else is SKIP, "not checked", never PASS.
 *   hub LaunchAgent   WARN for ~/Library/LaunchAgents/com.crosscheck.hub.plist
 *                     (macOS only): a user LaunchAgent runs as this user.
 *
 * Every probe is bounded, a probe that cannot answer is SKIP, and no line
 * prints a file's contents or a secret's value — only paths this user's own
 * HOME names, and process and user names screened to a plain alphabet.
 */
import { constants } from "node:fs";
import { access, lstat, opendir, stat } from "node:fs/promises";
import { join } from "node:path";

import { refuseRealHome } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";

import type { Check, CheckLevel } from "./doctor.ts";
import {
  defaultPlacementProbes,
  lookupListeners,
  placeHub,
  runCommand,
} from "./hub-separation-probes.ts";
import type { HubPlacement, Listener, ListenerLookup, PlacementProbes } from "./hub-separation-probes.ts";

export const HUB_HOME_DIR = ".crosscheck-hub";
export const HUB_ENV_FILE = "hub.env";
export const LAUNCH_AGENT_SEGMENTS = ["Library", "LaunchAgents", "com.crosscheck.hub.plist"] as const;
/** Looked at even when the hub home cannot be listed. */
const KNOWN_STATE_NAMES = ["data", "data.state", "trial-keys.txt"] as const;
const OPERATOR_TOKEN_ENV = "ADMIN_TOKEN";
const DATA_DIR_ENV = "CROSSCHECK_DATA_DIR";
const STATE_DIR_ENV = "CROSSCHECK_STATE_DIR";
/** The hub is a Bun program; any other listener is a front doctor cannot see behind. */
const HUB_RUNTIME_COMMAND = "bun";
const MAX_HUB_HOME_ENTRIES = 64;
const MAX_NAMED_PATHS = 3;
const MAX_PATH_CHARS = 200;
const PRINTABLE_NAME = /^[A-Za-z0-9 ._@+-]{1,32}$/;
const SEE_DOCS = 'see docs/OPERATIONS.md, "Running the hub under its own user"';
const NO_HOME = "not checked: HOME is not set, so doctor cannot find your default hub home";

const TOKEN_CHECK = "operator token";
const STATE_CHECK = "hub state";
const PROCESS_CHECK = "hub process";
const LAUNCH_AGENT_CHECK = "hub LaunchAgent";

export interface SeparationProbes extends PlacementProbes {
  readonly listListeners: (port: number) => Promise<ListenerLookup>;
  /** This process's uid; null where the platform has none. */
  readonly myUid: number | null;
  readonly platform: NodeJS.Platform;
}

export const defaultSeparationProbes = (): SeparationProbes => ({
  ...defaultPlacementProbes(),
  listListeners: (port) => lookupListeners(port, runCommand, process.platform),
  myUid: process.getuid?.() ?? null,
  platform: process.platform,
});

export interface HubSeparationInput {
  readonly env: Env;
  /** The hub this developer's doctor talks to. */
  readonly hubUrl: string;
  readonly probes?: Partial<SeparationProbes>;
}

const line = (level: CheckLevel, name: string, detail: string): Check => ({ level, name, detail });

/** A local path for the terminal: control and format characters replaced, length capped. */
const shown = (path: string): string => {
  const clean = path.replace(/[\p{Cc}\p{Cf}]/gu, "?");
  return clean.length > MAX_PATH_CHARS ? `${clean.slice(0, MAX_PATH_CHARS - 1)}…` : clean;
};

const screenedName = (name: string | null): string | null =>
  name !== null && PRINTABLE_NAME.test(name) ? name : null;

const nonEmpty = (value: string | undefined): string | null =>
  value === undefined || value.trim() === "" ? null : value;

type Exposure = "readable" | "writable" | "yours";

const canAccess = (path: string, mode: number): Promise<boolean> =>
  access(path, mode).then(
    () => true,
    () => false,
  );

const isNotFound = (error: unknown): boolean =>
  error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");

/**
 * What this user can do to `path`: read it, write it, or chmod it because it is
 * theirs. `null` when none — a path this user cannot even stat included —
 * and "absent" when it does not exist.
 */
const exposureOf = async (path: string, myUid: number | null): Promise<Exposure | "absent" | null> => {
  let ownerUid: number;
  try {
    ownerUid = (await stat(path)).uid;
  } catch (error) {
    return isNotFound(error) ? "absent" : null;
  }
  if (await canAccess(path, constants.R_OK)) {
    return "readable";
  }
  if (await canAccess(path, constants.W_OK)) {
    return "writable";
  }
  return myUid !== null && ownerUid === myUid ? "yours" : null;
};

const TOKEN_CONSEQUENCE: Readonly<Record<Exposure, string>> = {
  readable: "is readable by your user, so your agents can read it",
  writable: "is writable by your user, so your agents can replace it",
  yours: "belongs to your user, so your agents can make it readable",
};

const operatorTokenCheck = async (home: string | null, env: Env, myUid: number | null): Promise<Check> => {
  const isTokenInEnv = nonEmpty(env[OPERATOR_TOKEN_ENV]) !== null;
  const hubHome = home === null ? null : join(home, HUB_HOME_DIR);
  const path = hubHome === null ? null : join(hubHome, HUB_ENV_FILE);
  const fileExposure = path === null ? null : await exposureOf(path, myUid);
  const reasons = [
    ...(isTokenInEnv
      ? [`${OPERATOR_TOKEN_ENV} is set in this shell's environment, so every agent started from it inherits the operator token`]
      : []),
    ...(path === null || fileExposure === null || fileExposure === "absent"
      ? []
      : [`the operator token in ${shown(path)} ${TOKEN_CONSEQUENCE[fileExposure]}`]),
  ];
  if (reasons.length > 0) {
    return line("FAIL", TOKEN_CHECK, `${reasons.join("; ")} — move the hub under its own user (${SEE_DOCS})`);
  }
  if (hubHome === null || path === null) {
    return line("SKIP", TOKEN_CHECK, NO_HOME);
  }
  return fileExposure === "absent"
    ? line("PASS", TOKEN_CHECK, `no ${HUB_ENV_FILE} in ${shown(hubHome)}`)
    : line("PASS", TOKEN_CHECK, `${shown(path)} is not readable by your user`);
};

/** The hub home's entries (bounded) and the names it always holds, `hub.env` aside. */
const hubHomePaths = async (hubHome: string): Promise<readonly string[]> => {
  const listed: string[] = [];
  try {
    for await (const entry of await opendir(hubHome)) {
      listed.push(entry.name);
      if (listed.length >= MAX_HUB_HOME_ENTRIES) {
        break;
      }
    }
  } catch {
    // Absent or unlistable: the known names below are still stat'ed one by one.
  }
  return [...new Set([...listed, ...KNOWN_STATE_NAMES])]
    .filter((name) => name !== HUB_ENV_FILE)
    .map((name) => join(hubHome, name));
};

/** The data dir and state dir this environment names, as `crosscheck serve` would read them. */
const envStatePaths = (env: Env): readonly string[] => {
  const dataDir = nonEmpty(env[DATA_DIR_ENV]);
  return dataDir === null ? [] : [dataDir, nonEmpty(env[STATE_DIR_ENV]) ?? `${dataDir}.state`];
};

const hubStateCheck = async (home: string | null, env: Env, myUid: number | null): Promise<Check> => {
  if (home === null) {
    return line("SKIP", STATE_CHECK, NO_HOME);
  }
  const hubHome = join(home, HUB_HOME_DIR);
  const paths = [...new Set([...(await hubHomePaths(hubHome)), ...envStatePaths(env)])];
  const seen = await Promise.all(paths.map(async (path) => ({ path, exposure: await exposureOf(path, myUid) })));
  const present = seen.filter((entry) => entry.exposure !== "absent");
  const exposed = present.filter((entry) => entry.exposure !== null);
  if (exposed.length > 0) {
    const named = exposed.slice(0, MAX_NAMED_PATHS).map((entry) => shown(entry.path));
    const more = exposed.length > MAX_NAMED_PATHS ? ` and ${String(exposed.length - MAX_NAMED_PATHS)} more` : "";
    return line(
      "WARN",
      STATE_CHECK,
      `${named.join(", ")}${more} ${exposed.length === 1 ? "is" : "are"} readable or writable by your user, so your agents ` +
        `can read or change the hub's data — move the hub under its own user (${SEE_DOCS})`,
    );
  }
  return present.length === 0
    ? line("PASS", STATE_CHECK, `no hub state in ${shown(hubHome)}`)
    : line("PASS", STATE_CHECK, `none of the hub's ${String(present.length)} path(s) here is readable or writable by your user`);
};

const describeListener = (listener: Listener): string => {
  const command = screenedName(listener.command) ?? "a process";
  const user = screenedName(listener.user);
  return `${command}, ${user === null ? "" : `${user}, `}uid ${String(listener.uid)}`;
};

const isHubRuntime = (listener: Listener): boolean => listener.command === HUB_RUNTIME_COMMAND;

/** The process line from what the listener lookup found on the hub's local port. */
export const judgeListeners = (
  lookup: ListenerLookup,
  placement: Extract<HubPlacement, { kind: "local" }>,
  myUid: number | null,
): Check => {
  const where = `:${String(placement.port)}${placement.front === "tailscale serve" ? " behind tailscale serve" : ""}`;
  if (lookup.kind === "failed") {
    return line("SKIP", PROCESS_CHECK, `not checked: ${lookup.why}`);
  }
  if (lookup.kind === "none") {
    return line("SKIP", PROCESS_CHECK, `not checked: ${lookup.why}, so no hub runs there to judge`);
  }
  if (myUid === null) {
    return line("SKIP", PROCESS_CHECK, "not checked: this platform gives doctor no user id to compare");
  }
  const hubs = lookup.listeners.filter(isHubRuntime);
  const mine = hubs.filter((listener) => listener.uid === myUid);
  const first = mine[0];
  if (first !== undefined) {
    return line(
      "WARN",
      PROCESS_CHECK,
      `the hub runs as your user (${describeListener(first)}, on ${where}), so your agents can act as its operator — ` +
        `move it under its own user (${SEE_DOCS})`,
    );
  }
  const front = lookup.listeners.find((listener) => !isHubRuntime(listener));
  if (front !== undefined || hubs.length === 0) {
    return line(
      "SKIP",
      PROCESS_CHECK,
      `not checked: ${front === undefined ? "a process" : describeListener(front)} listens on ${where}, not the hub's ` +
        `${HUB_RUNTIME_COMMAND}, so doctor cannot see who runs the hub behind it`,
    );
  }
  return line(
    "PASS",
    PROCESS_CHECK,
    `the hub on ${where} runs as another user (${hubs.map(describeListener).join("; ")}), not as yours`,
  );
};

const hubProcessCheck = async (hubUrl: string, probes: SeparationProbes): Promise<Check> => {
  const placement = await placeHub(hubUrl, probes);
  if (placement.kind === "elsewhere") {
    return line("SKIP", PROCESS_CHECK, `not checked here: the hub runs elsewhere (${shown(placement.host)})`);
  }
  if (placement.kind === "unknown") {
    return line("SKIP", PROCESS_CHECK, `not checked: ${shown(placement.why)}`);
  }
  return judgeListeners(await probes.listListeners(placement.port), placement, probes.myUid);
};

const launchAgentCheck = async (home: string | null, platform: NodeJS.Platform): Promise<readonly Check[]> => {
  if (platform !== "darwin") {
    return [];
  }
  if (home === null) {
    return [line("SKIP", LAUNCH_AGENT_CHECK, NO_HOME)];
  }
  const path = join(home, ...LAUNCH_AGENT_SEGMENTS);
  const presence = await lstat(path).then(
    () => "present" as const,
    (error: unknown) => (isNotFound(error) ? ("absent" as const) : ("unreadable" as const)),
  );
  if (presence === "present") {
    return [
      line(
        "WARN",
        LAUNCH_AGENT_CHECK,
        `${shown(path)} starts the hub as your user — run it as a LaunchDaemon under its own user instead (${SEE_DOCS})`,
      ),
    ];
  }
  return presence === "absent"
    ? [line("PASS", LAUNCH_AGENT_CHECK, `no com.crosscheck.hub LaunchAgent in ${shown(join(home, "Library", "LaunchAgents"))}`)]
    : [line("SKIP", LAUNCH_AGENT_CHECK, `not checked: ${shown(path)} could not be looked at`)];
};

/**
 * The HOME `env` names, through the test home guard (config/paths.ts
 * `refuseRealHome`, integration review of batch 2, track A): in a test
 * process, a HOME that is the real user's throws here, before the probes'
 * net below could turn it into a SKIP line. Not `userHomeOf`: that falls back
 * to the process's home, and these lines must SKIP when `env` names none.
 */
const declaredHome = (env: Env): string | null => {
  const home = nonEmpty(env["HOME"]);
  return home === null ? null : refuseRealHome(home);
};

/**
 * The separation lines, for a configured hub. HOME comes from `env` alone —
 * never from the OS — so a caller that names no HOME gets SKIP lines, not a
 * look at whichever real home the process happens to have.
 */
export const hubSeparationChecks = async (input: HubSeparationInput): Promise<readonly Check[]> => {
  const probes: SeparationProbes = { ...defaultSeparationProbes(), ...input.probes };
  const home = declaredHome(input.env);
  try {
    const [token, state, hubProcess, agent] = await Promise.all([
      operatorTokenCheck(home, input.env, probes.myUid),
      hubStateCheck(home, input.env, probes.myUid),
      hubProcessCheck(input.hubUrl, probes),
      launchAgentCheck(home, probes.platform),
    ]);
    return [token, state, hubProcess, ...agent];
  } catch (error) {
    // Every probe above already answers failure as a value; this is the net
    // under a defect, and it still prints a line rather than losing the four.
    return [
      line(
        "SKIP",
        "hub separation",
        `not checked: the check itself failed (${error instanceof Error ? shown(error.name) : "unknown error"})`,
      ),
    ];
  }
};
