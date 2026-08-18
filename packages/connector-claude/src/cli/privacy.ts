/**
 * `crosscheck presence off|on`, `crosscheck mute <developer>`, `crosscheck
 * unmute <developer>`, `crosscheck mute list` — the CLI over the hub's
 * /api/settings surface (DESIGN.md §2.1 "per-developer presence opt-out and
 * mute", §10 risk 3).
 *
 * The scope statements printed here are part of the control's contract: an
 * opt-out must say it does NOT retract published knowledge, and a mute must
 * say pulled content stays reachable — otherwise the first surprise erodes
 * trust in the whole privacy story.
 */
import { EXIT_FAIL, EXIT_OK, EXIT_UNREACHABLE, EXIT_USAGE } from "../constants.ts";
import { loadConfig } from "../config/config.ts";
import type { Env } from "../config/paths.ts";
import { resolveRepoIdentity } from "../git/repo-identity.ts";
import {
  deleteMute,
  getPrivacySettings,
  postMute,
  putPresenceOptOut,
} from "../http/hub.ts";
import type { HubContext } from "../http/hub.ts";
import type { CliResult } from "./login.ts";

export const PRESENCE_USAGE = [
  "usage: crosscheck presence        show whether teammates can see you",
  "   or: crosscheck presence off    hide your live presence from teammates",
  "   or: crosscheck presence on     show your live presence again",
  "",
].join("\n");

export const MUTE_USAGE = [
  "usage: crosscheck mute <developer>    stop seeing hints/pointers about them",
  "   or: crosscheck mute list           show who you have muted",
  "   or: crosscheck unmute <developer>",
  "",
].join("\n");

/**
 * What opting out hides and — just as important — what it does not. The
 * hub-side surface list lives in packages/server/src/services/visibility.ts;
 * these lines are its user-facing mirror.
 */
const OPT_OUT_SCOPE = [
  "",
  "Hidden from other developers: active-teammate briefing lines, statusline",
  "presence, PreToolUse same-file asks, absence (\"connector inactive\")",
  "lines, and every activity-feed event attributed to you — session",
  "start/end and knowledge events alike, since feed timestamps reveal when",
  "you work. Your own view of your own activity is unaffected.",
  "",
  "NOT retracted: claims, diagnoses and solved trees you published",
  "stay visible and attributed — opt-out covers live presence, not",
  "authorship. Caveat: commits under a git email the hub cannot match to",
  "your account may still appear to teammates as \"not connected\" absence",
  "lines under that git name.",
  "",
].join("\n");

const muteScope = (name: string): string =>
  [
    "",
    `${name}'s content no longer appears in your unasked surfaces: prompt`,
    "hints, briefing pointers (related work, solved trees, contradictions,",
    "absence lines), statusline presence and tripwire asks.",
    "",
    "It stays reachable when you pull it deliberately (search_related_work,",
    "get_diagnosis, get_referee_brief).",
    "",
  ].join("\n");

const NOT_CONFIGURED = "not configured — run `crosscheck login <hubUrl>`\n";

/**
 * Hub context for settings calls: hub-wide, not repo-scoped, so repoKey stays
 * empty and no per-repo sync state is written for a settings command.
 */
const settingsContext = async (
  env: Env,
  cwd: string,
): Promise<HubContext | null> => {
  const identity = await resolveRepoIdentity(cwd);
  const config = await loadConfig({ env, repoRoot: identity?.root });
  if (config === null) {
    return null;
  }
  return {
    hubUrl: config.hubUrl,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    home: config.home,
    repoKey: "",
    now: () => new Date(),
  };
};

const failureResult = (result: {
  readonly kind: "network" | "http" | "malformed";
  readonly message: string;
}): CliResult =>
  result.kind === "network"
    ? {
        stdout: `hub unreachable: ${result.message}\n`,
        exitCode: EXIT_UNREACHABLE,
      }
    : { stdout: `${result.message}\n`, exitCode: EXIT_FAIL };

export const presenceStateLine = (optOut: boolean): string =>
  optOut
    ? "presence: hidden from teammates (run `crosscheck presence on` to show)"
    : "presence: visible to teammates";

const showPresence = async (ctx: HubContext): Promise<CliResult> => {
  const settings = await getPrivacySettings(ctx);
  if (!settings.ok) {
    return failureResult(settings);
  }
  return {
    stdout: `${presenceStateLine(settings.data.presenceOptOut)}\n`,
    exitCode: EXIT_OK,
  };
};

const setPresence = async (
  ctx: HubContext,
  optOut: boolean,
): Promise<CliResult> => {
  const result = await putPresenceOptOut(ctx, optOut);
  if (!result.ok) {
    return failureResult(result);
  }
  if (optOut) {
    return {
      stdout: `${presenceStateLine(true)}\n${OPT_OUT_SCOPE}`,
      exitCode: EXIT_OK,
    };
  }
  return { stdout: `${presenceStateLine(false)}\n`, exitCode: EXIT_OK };
};

export const runPresence = async (
  args: readonly string[],
  env: Env,
  cwd: string,
): Promise<CliResult> => {
  const [subcommand, ...rest] = args;
  const isKnown =
    subcommand === undefined || subcommand === "off" || subcommand === "on";
  if (!isKnown || rest.length > 0) {
    return { stdout: PRESENCE_USAGE, exitCode: EXIT_USAGE };
  }
  const ctx = await settingsContext(env, cwd);
  if (ctx === null) {
    return { stdout: NOT_CONFIGURED, exitCode: EXIT_FAIL };
  }
  if (subcommand === undefined) {
    return showPresence(ctx);
  }
  return setPresence(ctx, subcommand === "off");
};

const listMutes = async (ctx: HubContext): Promise<CliResult> => {
  const settings = await getPrivacySettings(ctx);
  if (!settings.ok) {
    return failureResult(settings);
  }
  if (settings.data.mutes.length === 0) {
    return { stdout: "muted developers: (none)\n", exitCode: EXIT_OK };
  }
  const lines = settings.data.mutes.map((mute) => `  - ${mute.name}`);
  return {
    stdout: ["muted developers:", ...lines, ""].join("\n"),
    exitCode: EXIT_OK,
  };
};

export const runMute = async (
  args: readonly string[],
  env: Env,
  cwd: string,
): Promise<CliResult> => {
  const [ref, ...rest] = args;
  if (rest.length > 0) {
    return { stdout: MUTE_USAGE, exitCode: EXIT_USAGE };
  }
  const ctx = await settingsContext(env, cwd);
  if (ctx === null) {
    return { stdout: NOT_CONFIGURED, exitCode: EXIT_FAIL };
  }
  // Bare `mute` and `mute list` both list — a developer named "list" can
  // still be muted by email or id (the hub resolves all three).
  if (ref === undefined || ref === "list") {
    return listMutes(ctx);
  }
  const result = await postMute(ctx, ref);
  if (!result.ok) {
    return failureResult(result);
  }
  const name = result.data.muted.name;
  const headline = result.data.alreadyMuted
    ? `${name} was already muted`
    : `muted ${name}`;
  return { stdout: `${headline}\n${muteScope(name)}`, exitCode: EXIT_OK };
};

export const runUnmute = async (
  args: readonly string[],
  env: Env,
  cwd: string,
): Promise<CliResult> => {
  const [ref, ...rest] = args;
  if (ref === undefined || rest.length > 0) {
    return { stdout: MUTE_USAGE, exitCode: EXIT_USAGE };
  }
  const ctx = await settingsContext(env, cwd);
  if (ctx === null) {
    return { stdout: NOT_CONFIGURED, exitCode: EXIT_FAIL };
  }
  const result = await deleteMute(ctx, ref);
  if (!result.ok) {
    return failureResult(result);
  }
  const name = result.data.unmuted.name;
  return {
    stdout: result.data.wasMuted
      ? `unmuted ${name}\n`
      : `${name} was not muted\n`,
    exitCode: EXIT_OK,
  };
};
