import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import {
  CLAUDE_SETTINGS_DIR,
  CLAUDE_SETTINGS_FILE,
  DOCTOR_LAST_SYNC_WARN_MINUTES,
  DOCTOR_SPOOL_AGE_WARN_HOURS,
  DOCTOR_SPOOL_DEPTH_FAIL,
  DOCTOR_SPOOL_DEPTH_WARN,
  EXIT_FAIL,
  EXIT_OK,
  EXIT_WARN,
  MAX_CLOCK_SKEW_SECONDS,
  MINUTES_PER_HOUR,
  MS_PER_SECOND,
  PRIVATE_FILE_MODE,
  PROBE_REPO,
  SECONDS_PER_MINUTE,
} from "../constants.ts";
import { loadConfig } from "../config/config.ts";
import {
  configPath,
  crosscheckHome,
  readTextOrNull,
  repoKey,
} from "../config/paths.ts";
import type { Env } from "../config/paths.ts";
import { formatAge } from "../briefing/render.ts";
import { resolveRepoIdentity } from "../git/repo-identity.ts";
import { hubRequest } from "../http/client.ts";
import { readDropSummary, readUnrecordedDrop } from "../spool/drops.ts";
import { oldestSpoolLineMs, spoolDepth } from "../spool/files.ts";
import { readUnclosedSummary } from "../spool/unclosed.ts";
import { readSyncState } from "../state/sync-state.ts";
import { isOwnedCommand } from "./settings-merge.ts";
import type { CliResult } from "./login.ts";

export type CheckLevel = "PASS" | "WARN" | "FAIL";

export interface Check {
  readonly level: CheckLevel;
  readonly name: string;
  readonly detail: string;
}

const check = (level: CheckLevel, name: string, detail: string): Check => ({
  level,
  name,
  detail,
});

const MS_PER_MINUTE = MS_PER_SECOND * SECONDS_PER_MINUTE;
const MS_PER_HOUR = MS_PER_MINUTE * MINUTES_PER_HOUR;
const HTTP_UNAUTHORIZED = 401;

const checkConfig = async (home: string): Promise<Check> => {
  const path = configPath(home);
  const raw = await readTextOrNull(path);
  if (raw === null) {
    return check("FAIL", "config present", `${path} not found`);
  }
  try {
    JSON.parse(raw);
  } catch {
    return check("FAIL", "config present", `${path} is not valid json`);
  }
  try {
    const info = await stat(path);
    const mode = info.mode & 0o777;
    if (mode !== PRIVATE_FILE_MODE) {
      return check(
        "WARN",
        "config present",
        `mode ${mode.toString(8)}, expected 600`,
      );
    }
  } catch {
    return check("WARN", "config present", "mode could not be read");
  }
  return check("PASS", "config present", path);
};

const BUNFIG_NAMES = ["bunfig.toml", ".bunfig.toml"] as const;
/** TOML is not parsed here: one key is all this check needs to recognise. */
const DEBUG_LOG_LEVEL_PATTERN = /^\s*logLevel\s*=\s*["'](debug|verbose)["']/m;

const bunfigCandidates = (env: Env, cwd: string, repoRoot: string | null): readonly string[] => {
  const homeDir = env["HOME"] ?? homedir();
  const roots = [cwd, ...(repoRoot === null ? [] : [repoRoot]), homeDir];
  const xdg = env["XDG_CONFIG_HOME"];
  const paths = [
    ...roots.flatMap((root) => BUNFIG_NAMES.map((name) => join(root, name))),
    ...(xdg === undefined ? [] : [join(xdg, ".bunfig.toml")]),
  ];
  return [...new Set(paths)];
};

/**
 * Bun's verbose logging prints the whole request, Authorization header
 * included, to hook stderr — a leak of OUR credential caused by the runtime.
 * The connector cannot switch that off from inside its own process, so the
 * honest answer is to name the file and say the key has to be rotated.
 */
const checkBunfig = async (
  env: Env,
  cwd: string,
  repoRoot: string | null,
): Promise<Check> => {
  for (const path of bunfigCandidates(env, cwd, repoRoot)) {
    const raw = await readTextOrNull(path);
    if (raw !== null && DEBUG_LOG_LEVEL_PATTERN.test(raw)) {
      return check(
        "WARN",
        "bun request logging",
        `${path} enables debug logging — bun then prints the api key (Authorization header) to hook stderr; rotate the key if it was logged`,
      );
    }
  }
  return check("PASS", "bun request logging", "no debug logLevel found");
};

const checkSettings = async (repoRoot: string): Promise<readonly Check[]> => {
  const path = join(repoRoot, CLAUDE_SETTINGS_DIR, CLAUDE_SETTINGS_FILE);
  const raw = await readTextOrNull(path);
  if (raw === null) {
    return [
      check("FAIL", "hooks registered", `${path} not found — run crosscheck init`),
      check("WARN", "statusline registered", "no settings file"),
    ];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [
      check("FAIL", "hooks registered", `${path} is not valid json`),
      check("WARN", "statusline registered", "settings unparseable"),
    ];
  }

  const settings = z
    .looseObject({
      hooks: z.record(z.string(), z.unknown()).optional(),
      statusLine: z.looseObject({ command: z.string() }).optional(),
    })
    .safeParse(parsed);
  if (!settings.success) {
    return [
      check("FAIL", "hooks registered", "settings shape unrecognised"),
      check("WARN", "statusline registered", "settings shape unrecognised"),
    ];
  }

  const hooks = settings.data.hooks ?? {};
  const ownedCommands = Object.entries(hooks).flatMap(([event, groups]) =>
    (Array.isArray(groups) ? groups : []).flatMap((group) => {
      const entries = (group as Record<string, unknown>)["hooks"];
      return (Array.isArray(entries) ? entries : [])
        .map((entry) => (entry as Record<string, unknown>)["command"])
        .filter(isOwnedCommand)
        .map((command) => ({ event, command: String(command) }));
    }),
  );

  const required = ["SessionStart", "PostToolUse", "SessionEnd"];
  const missing = required.filter(
    (event) => !ownedCommands.some((entry) => entry.event === event),
  );
  const unexpected = ownedCommands.filter(
    (entry) => !required.includes(entry.event),
  );
  const hooksCheck =
    missing.length > 0
      ? check("FAIL", "hooks registered", `missing: ${missing.join(", ")}`)
      : unexpected.length > 0
        ? check(
            "WARN",
            "hooks registered",
            `unexpected crosscheck entries: ${unexpected.map((entry) => entry.event).join(", ")}`,
          )
        : check("PASS", "hooks registered", required.join(", "));

  const statuslineCommand = settings.data.statusLine?.command;
  const statuslineCheck =
    statuslineCommand === undefined
      ? check("WARN", "statusline registered", "no statusline configured")
      : isOwnedCommand(statuslineCommand)
        ? check("PASS", "statusline registered", statuslineCommand)
        : check(
            "WARN",
            "statusline registered",
            `foreign statusline: ${statuslineCommand}`,
          );
  return [hooksCheck, statuslineCheck];
};

const checkSpool = async (
  home: string,
  key: string,
  now: Date,
): Promise<readonly Check[]> => {
  const depth = await spoolDepth(home, key);
  const depthCheck =
    depth > DOCTOR_SPOOL_DEPTH_FAIL
      ? check("FAIL", "spool depth", `${depth} pending records`)
      : depth > DOCTOR_SPOOL_DEPTH_WARN
        ? check("WARN", "spool depth", `${depth} pending records`)
        : check("PASS", "spool depth", `${depth} pending records`);

  const oldestMs = await oldestSpoolLineMs(home, key);
  const ageHours =
    oldestMs === null ? 0 : (now.getTime() - oldestMs) / MS_PER_HOUR;
  const ageCheck =
    ageHours > DOCTOR_SPOOL_AGE_WARN_HOURS
      ? check(
          "WARN",
          "spool age",
          `oldest record ${formatAge(now.getTime() - (oldestMs ?? 0))} old`,
        )
      : check("PASS", "spool age", oldestMs === null ? "empty" : "fresh");

  // Counted from the append-only `.drops` ledger, not from a shared counter:
  // the number is exact even when several hooks dropped at the same moment.
  const drops = await readDropSummary(home, key);
  // Exact for what reached a ledger, that is. A batch whose ledger append
  // failed is in no sum, so while this marker exists the number above is a
  // floor and has to be read as one (spool/drops.ts).
  const unrecorded = await readUnrecordedDrop(home, key);
  const droppedCheck =
    drops.records > 0 || drops.malformed > 0 || unrecorded !== null
      ? check(
          "WARN",
          "spool drops",
          `${drops.records} records discarded in ${drops.entries} batches` +
            (drops.malformed > 0
              ? `, ${drops.malformed} ledger entries unreadable`
              : "") +
            (unrecorded === null
              ? ""
              : `, plus at least one batch its ledger could not take (${unrecorded.count} records, ${unrecorded.reason}, ${unrecorded.at}) — the total is a lower bound`),
        )
      : check("PASS", "spool drops", "none");

  // A session the hub still believes is running, because the `end` for it aged
  // out of the spool before any hook had the spare budget to deliver it. The
  // marker is gone by the time this reads; the count is what survived it.
  const unclosed = await readUnclosedSummary(home, key);
  const oldestUnclosedMs =
    unclosed.oldestAt === null ? Number.NaN : Date.parse(unclosed.oldestAt);
  const unclosedCheck =
    unclosed.sessions > 0
      ? check(
          "WARN",
          "unclosed sessions",
          `${unclosed.sessions} session end${unclosed.sessions === 1 ? "" : "s"} expired undelivered` +
            (Number.isNaN(oldestUnclosedMs)
              ? ""
              : `, oldest ${formatAge(now.getTime() - oldestUnclosedMs)} ago`),
        )
      : check("PASS", "unclosed sessions", "none");
  return [depthCheck, ageCheck, droppedCheck, unclosedCheck];
};

/** A live session file plus a stale sync is exactly the silent-death signature. */
const hasLiveSessionState = async (home: string): Promise<boolean> => {
  try {
    return (await readdir(join(home, "sessions"))).length > 0;
  } catch {
    return false;
  }
};

const checkLastSync = async (
  home: string,
  key: string,
  now: Date,
): Promise<Check> => {
  const sync = await readSyncState(home, key);
  if (sync.lastOkAt === null) {
    return check("WARN", "last sync", "never synced");
  }
  const ageMs = now.getTime() - Date.parse(sync.lastOkAt);
  const isStale = ageMs > DOCTOR_LAST_SYNC_WARN_MINUTES * MS_PER_MINUTE;
  return isStale && (await hasLiveSessionState(home))
    ? check("WARN", "last sync", `${formatAge(ageMs)} ago with a live session`)
    : check("PASS", "last sync", `${formatAge(ageMs)} ago`);
};

const summarize = (checks: readonly Check[]): CliResult => {
  const lines = checks.map(
    (entry) => `${entry.level}  ${entry.name}  ${entry.detail}`,
  );
  const failures = checks.filter((entry) => entry.level === "FAIL").length;
  const warnings = checks.filter((entry) => entry.level === "WARN").length;
  const exitCode =
    failures > 0 ? EXIT_FAIL : warnings > 0 ? EXIT_WARN : EXIT_OK;
  return {
    stdout: [
      ...lines,
      `${checks.length - failures - warnings} pass, ${warnings} warn, ${failures} fail`,
      "",
    ].join("\n"),
    exitCode,
  };
};

export const runDoctor = async (env: Env, cwd: string): Promise<CliResult> => {
  const now = new Date();
  const home = crosscheckHome(env);
  const configCheck = await checkConfig(home);
  const identity = await resolveRepoIdentity(cwd);
  const identityCheck =
    identity === null
      ? check("FAIL", "repo identity", "not a git repository")
      : check("PASS", "repo identity", identity.repoId);

  const bunfigCheck = await checkBunfig(env, cwd, identity?.root ?? null);
  const config = await loadConfig({ env, repoRoot: identity?.root });
  if (config === null || identity === null) {
    return summarize([
      configCheck,
      identityCheck,
      check("FAIL", "hub reachable", "no hub configured"),
      bunfigCheck,
    ]);
  }

  const key = repoKey(config.hubUrl, identity.repoId);
  const probe = await hubRequest(
    {
      hubUrl: config.hubUrl,
      apiKey: config.apiKey,
      timeoutMs: config.timeoutMs,
      home: config.home,
      repoKey: key,
      now: () => now,
    },
    {
      method: "GET",
      path: `/api/presence?repo=${encodeURIComponent(PROBE_REPO)}`,
      schema: z.unknown(),
    },
  );
  const hubCheck = probe.ok
    ? check("PASS", "hub reachable", config.hubUrl)
    : check(
        "FAIL",
        "hub reachable",
        probe.status === HTTP_UNAUTHORIZED
          ? "invalid api key"
          : `${config.hubUrl}: ${probe.message}`,
      );

  const skewCheck = ((): Check => {
    if (!probe.ok || probe.dateHeader === null) {
      return check("PASS", "clock skew", "not measured");
    }
    const hubMs = Date.parse(probe.dateHeader);
    if (Number.isNaN(hubMs)) {
      return check("PASS", "clock skew", "not measured");
    }
    const skewSeconds = Math.abs(now.getTime() - hubMs) / MS_PER_SECOND;
    return skewSeconds > MAX_CLOCK_SKEW_SECONDS
      ? check("FAIL", "clock skew", `${Math.round(skewSeconds)}s vs hub`)
      : check("PASS", "clock skew", `${Math.round(skewSeconds)}s vs hub`);
  })();

  return summarize([
    configCheck,
    identityCheck,
    hubCheck,
    ...(await checkSettings(identity.root)),
    ...(await checkSpool(config.home, key, now)),
    await checkLastSync(config.home, key, now),
    skewCheck,
    bunfigCheck,
  ]);
};
