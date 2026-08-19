import { readdir, readlink, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import { z } from "zod";

import {
  CLAUDE_SETTINGS_DIR,
  CLAUDE_SETTINGS_FILE,
  DOCTOR_AGENT_CWD_TIMEOUT_MS,
  DOCTOR_AGENT_MAX_CWD_PROBES,
  DOCTOR_AGENT_PS_MAX_LINES,
  DOCTOR_AGENT_PS_TIMEOUT_MS,
  DOCTOR_FLUSH_LOCK_WARN_MS,
  DOCTOR_LAST_SYNC_WARN_MINUTES,
  DOCTOR_SPOOL_AGE_WARN_HOURS,
  DOCTOR_SPOOL_DEPTH_FAIL,
  DOCTOR_SPOOL_DEPTH_WARN,
  EXIT_FAIL,
  EXIT_OK,
  EXIT_WARN,
  LATENCY_PROBE_TIMEOUT_MS,
  LATENCY_TIMEOUT_MAX_MS,
  MAX_CLOCK_SKEW_SECONDS,
  MCP_CONFIG_FILE,
  MCP_SERVER_KEY,
  MINUTES_PER_HOUR,
  MS_PER_SECOND,
  PRIVATE_FILE_MODE,
  PROBE_REPO,
  SECONDS_PER_MINUTE,
} from "@crosscheck/connector-core/constants.ts";
import { loadConfig } from "@crosscheck/connector-core/config/config.ts";
import { timeoutOwner } from "@crosscheck/connector-core/config/timeout-policy.ts";
import type { TimeoutOwner } from "@crosscheck/connector-core/config/timeout-policy.ts";
import {
  configPath,
  crosscheckHome,
  readTextOrNull,
  repoKey,
  spoolFlushLockPath,
} from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { formatAge } from "@crosscheck/connector-core/briefing/render.ts";
import { realpathBestEffort } from "@crosscheck/connector-core/config/paths.ts";
import { runBoundedCommand } from "@crosscheck/connector-core/git/git.ts";
import { resolveRepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import { hubRequest } from "@crosscheck/connector-core/http/client.ts";
import type { HubContext } from "@crosscheck/connector-core/http/client.ts";
import {
  describeConnectionFailure,
  refineRefusedCause,
} from "@crosscheck/connector-core/http/connection-error.ts";
import {
  isFlapRisk,
  measureHubLatency,
  recommendedTimeoutMs,
} from "@crosscheck/connector-core/http/latency.ts";
import type { LatencyMeasurement } from "@crosscheck/connector-core/http/latency.ts";
import { getAbsences, getPrivacySettings } from "@crosscheck/connector-core/http/hub.ts";
import { readDropSummary, readUnrecordedDrop } from "@crosscheck/connector-core/spool/drops.ts";
import { oldestSpoolLineMs, spoolDepth } from "@crosscheck/connector-core/spool/files.ts";
import { readLockHolder } from "@crosscheck/connector-core/spool/lock.ts";
import { readUnclosedSummary } from "@crosscheck/connector-core/spool/unclosed.ts";
import { readSyncState } from "@crosscheck/connector-core/state/sync-state.ts";
import { checkLauncherCommand } from "@crosscheck/connector-core/config/launcher-check.ts";
import {
  formatSummarizerCost,
  readSummarizerCost,
} from "@crosscheck/connector-claude";
import { isOwnedMcpEntry } from "@crosscheck/connector-core/config/mcp-config.ts";
import { isOwnedCommand } from "@crosscheck/connector-claude";
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
 * included, to the stderr of every bun process in that cwd. The connector's
 * OWN hub calls are shielded — the one fetch in http/client.ts passes
 * `verbose: false`, which is the only mechanism that beats the bunfig
 * (measured; test/bunfig-leak.test.ts) — so the WARN stays for what the
 * shield cannot cover: other bun processes in the repo printing THEIR
 * headers, and any older connector version that ran here before the shield.
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
        `${path} enables debug logging — this connector's own hub calls are shielded (fetch verbose:false), but bun prints request headers for every other process here, and a connector older than the shield leaked the api key: rotate the key if one ran in this repo`,
      );
    }
  }
  return check("PASS", "bun request logging", "no debug logLevel found");
};

interface SettingsInspection {
  readonly checks: readonly Check[];
  /** The first owned hook command — what `checkLauncher` resolves and runs. */
  readonly launcherCommand: string | null;
}

const settingsOnly = (checks: readonly Check[]): SettingsInspection => ({
  checks,
  launcherCommand: null,
});

const checkSettings = async (repoRoot: string): Promise<SettingsInspection> => {
  const path = join(repoRoot, CLAUDE_SETTINGS_DIR, CLAUDE_SETTINGS_FILE);
  const raw = await readTextOrNull(path);
  if (raw === null) {
    return settingsOnly([
      check("FAIL", "hooks registered", `${path} not found — run crosscheck init`),
      check("WARN", "statusline registered", "no settings file"),
    ]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return settingsOnly([
      check("FAIL", "hooks registered", `${path} is not valid json`),
      check("WARN", "statusline registered", "settings unparseable"),
    ]);
  }

  const settings = z
    .looseObject({
      hooks: z.record(z.string(), z.unknown()).optional(),
      statusLine: z.looseObject({ command: z.string() }).optional(),
    })
    .safeParse(parsed);
  if (!settings.success) {
    return settingsOnly([
      check("FAIL", "hooks registered", "settings shape unrecognised"),
      check("WARN", "statusline registered", "settings shape unrecognised"),
    ]);
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

  const required = [
    "SessionStart",
    "PostToolUse",
    "SessionEnd",
    "UserPromptSubmit",
    "PreToolUse",
    "Stop",
  ];
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
  return {
    checks: [hooksCheck, statuslineCheck],
    launcherCommand: ownedCommands[0]?.command ?? null,
  };
};

/**
 * Whether the launcher the hooks call would actually RUN, checked the way a
 * hook resolves it. The probe bodies MOVED to core for Block 6
 * (@crosscheck/connector-core/config/launcher-check.ts) — the Cursor doctor
 * section runs the identical checks on `.cursor/hooks.json` commands and
 * cannot import from this package. What stays here is the Claude keyword
 * list and the Check envelope.
 */
const checkLauncher = async (command: string, env: Env): Promise<Check> => {
  const result = await checkLauncherCommand(command, env, [
    "hook",
    "statusline",
  ]);
  return check(result.level, "hook launcher", result.detail);
};

/**
 * ── Agent-restart check (trial finding #8) ─────────────────────────────────
 *
 * Hooks load at agent/editor process start, so a session already running
 * when `crosscheck init` wrote the settings keeps running WITHOUT them —
 * silently, hooks failing open by design. A teammate lost a morning to it.
 * This check turns that state into a sentence: a known agent process, in
 * THIS repo, started before the settings file was written.
 *
 * "In THIS repo" is the load-bearing half. An agent running in a different
 * repo is untouched by this repo's hooks — a name-and-age match alone would
 * warn on every developer machine with two projects, and that noise is how
 * doctors get ignored. So each age-matched candidate's working directory is
 * resolved (readlink /proc/<pid>/cwd on Linux, one bounded lsof on macOS)
 * and only a cwd inside the repo root convicts. Every resolution failure is
 * fail-open: a missed warning over a wrong one. GUI editors whose cwd is
 * "/" (Cursor's app process) are therefore never flagged — acceptable,
 * because Cursor hot-reloads its hook files; the CLI agents this check can
 * see are exactly the ones that need the restart.
 */
export interface AgentProcessProbe {
  /** Raw `ps -axo pid=,etime=,comm=` output, or null = not measurable. */
  readonly listProcesses: () => Promise<string | null>;
  /** The process's working directory, or null when it cannot be known. */
  readonly resolveCwd: (pid: number) => Promise<string | null>;
}

/** Process names that are coding agents whose hooks load at start. */
const AGENT_PROCESS_NAMES = new Set(["claude", "cursor"]);

const SECONDS_PER_HOUR = SECONDS_PER_MINUTE * MINUTES_PER_HOUR;
const SECONDS_PER_DAY = SECONDS_PER_HOUR * 24;

/** `ps` etime — [[dd-]hh:]mm:ss — as seconds, or null for anything else. */
export const parsePsEtime = (etime: string): number | null => {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (match === null) {
    return null;
  }
  const days = match[1] === undefined ? 0 : Number.parseInt(match[1], 10);
  const hours = match[2] === undefined ? 0 : Number.parseInt(match[2], 10);
  const minutes = Number.parseInt(match[3] ?? "0", 10);
  const seconds = Number.parseInt(match[4] ?? "0", 10);
  if (seconds >= 60 || minutes >= 60 || hours >= 24) {
    return null;
  }
  return (
    days * SECONDS_PER_DAY +
    hours * SECONDS_PER_HOUR +
    minutes * SECONDS_PER_MINUTE +
    seconds
  );
};

interface AgentCandidate {
  readonly pid: number;
  readonly name: string;
  readonly startedAtMs: number;
}

/** One ps line — "<pid> <etime> <comm…>" — or null for anything unparseable. */
const parsePsLine = (line: string, nowMs: number): AgentCandidate | null => {
  const tokens = line.trim().split(/\s+/);
  const [pidToken, etimeToken, ...commTokens] = tokens;
  if (pidToken === undefined || etimeToken === undefined || commTokens.length === 0) {
    return null;
  }
  const pid = Number.parseInt(pidToken, 10);
  const elapsedSeconds = parsePsEtime(etimeToken);
  if (!Number.isSafeInteger(pid) || pid <= 0 || elapsedSeconds === null) {
    return null;
  }
  const name = basename(commTokens.join(" ")).toLowerCase();
  if (!AGENT_PROCESS_NAMES.has(name)) {
    return null;
  }
  return { pid, name, startedAtMs: nowMs - elapsedSeconds * MS_PER_SECOND };
};

const isInsideRepo = async (repoRoot: string, cwd: string): Promise<boolean> => {
  const root = await realpathBestEffort(repoRoot);
  const resolved = await realpathBestEffort(cwd);
  const rel = relative(root, resolved);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
};

export const checkAgentRestart = async (
  repoRoot: string,
  settingsPath: string,
  probe: AgentProcessProbe,
  nowMs: number,
): Promise<Check> => {
  const name = "agent restart";
  try {
    const settingsMtimeMs = await stat(settingsPath).then(
      (info) => info.mtimeMs,
      () => null,
    );
    if (settingsMtimeMs === null) {
      return check("PASS", name, "not measured (no settings file)");
    }
    const raw = await probe.listProcesses();
    if (raw === null) {
      return check("PASS", name, "not measured");
    }
    // Age first, cwd second: the pre-filter keeps the per-pid probes (a
    // spawn each on macOS) to the handful that could matter at all.
    const candidates = raw
      .split("\n")
      .slice(0, DOCTOR_AGENT_PS_MAX_LINES)
      .flatMap((line) => {
        const parsed = parsePsLine(line, nowMs);
        return parsed === null || parsed.startedAtMs >= settingsMtimeMs
          ? []
          : [parsed];
      })
      .slice(0, DOCTOR_AGENT_MAX_CWD_PROBES);
    const offenders: AgentCandidate[] = [];
    for (const candidate of candidates) {
      const cwd = await probe.resolveCwd(candidate.pid).catch(() => null);
      if (cwd !== null && (await isInsideRepo(repoRoot, cwd))) {
        offenders.push(candidate);
      }
    }
    if (offenders.length === 0) {
      return check("PASS", name, "no running agent predates the hooks");
    }
    const listed = offenders
      .map((entry) => `pid ${String(entry.pid)} (${entry.name})`)
      .join(", ");
    return check(
      "WARN",
      name,
      `a running agent predates your hooks — restart it: ${listed} in this repo started before ${CLAUDE_SETTINGS_DIR}/${CLAUDE_SETTINGS_FILE} was written, and hooks load only at process start`,
    );
  } catch {
    // Never crashes doctor: any surprise is a "not measured", not a report.
    return check("PASS", name, "not measured");
  }
};

/** The real probe: ps once, then /proc (Linux) or bounded lsof (macOS). */
const defaultAgentProbe = (cwd: string): AgentProcessProbe => ({
  listProcesses: async () =>
    process.platform === "linux" || process.platform === "darwin"
      ? runBoundedCommand(
          ["ps", "-axo", "pid=,etime=,comm="],
          cwd,
          DOCTOR_AGENT_PS_TIMEOUT_MS,
        )
      : null,
  resolveCwd: async (pid) => {
    if (process.platform === "linux") {
      try {
        return await readlink(`/proc/${String(pid)}/cwd`);
      } catch {
        return null;
      }
    }
    if (process.platform === "darwin") {
      const output = await runBoundedCommand(
        ["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"],
        cwd,
        DOCTOR_AGENT_CWD_TIMEOUT_MS,
      );
      const nameLine = output
        ?.split("\n")
        .find((line) => line.startsWith("n"));
      return nameLine === undefined ? null : nameLine.slice(1);
    }
    return null;
  },
});

/**
 * Whether an agent in this repo can reach the diagnosis tree at all.
 *
 * RULE 6, ON THE SURFACE WHERE IT BITES HARDEST. A hook that cannot run is
 * invisible by design — it exits 0 and says nothing, and `last sync` above is
 * what notices. An MCP tool is the opposite: a failing CALL is loud, which is
 * better, but a tool that was never REGISTERED is never called, so it produces
 * no message of any kind and nothing else on this machine would say so. That
 * silence is what these two checks are for.
 *
 * Two checks rather than one, because they have different fixes. REGISTERED is
 * about this repo's committed `.mcp.json` and is fixed by `crosscheck init`
 * plus committing the result. USABLE is about credentials and is fixed by
 * `crosscheck login`. A single line saying "the tools do not work" would send
 * half the readers to the wrong command.
 */
const checkMcpRegistration = async (repoRoot: string): Promise<Check> => {
  const path = join(repoRoot, MCP_CONFIG_FILE);
  const raw = await readTextOrNull(path);
  if (raw === null) {
    return check(
      "FAIL",
      "mcp tools registered",
      `${path} not found — run crosscheck init, then commit the file so teammates get the tools too`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    // WARN rather than FAIL, and the difference is the fix: a missing file is
    // re-created by `init`, whereas a corrupt one has to be read by a human —
    // `init` deliberately refuses to overwrite it.
    return check(
      "WARN",
      "mcp tools registered",
      `${path} is not valid json — crosscheck init will refuse to touch it until that is fixed`,
    );
  }
  const servers = z
    .looseObject({ mcpServers: z.record(z.string(), z.unknown()).optional() })
    .safeParse(parsed);
  const entry = servers.success
    ? servers.data.mcpServers?.[MCP_SERVER_KEY]
    : undefined;
  if (entry === undefined) {
    return check(
      "FAIL",
      "mcp tools registered",
      `${path} has no "${MCP_SERVER_KEY}" server — run crosscheck init`,
    );
  }
  // The KEY being present is not enough: a hand-written entry under this name
  // pointing somewhere else would otherwise be reported as a healthy install.
  return isOwnedMcpEntry(entry)
    ? check("PASS", "mcp tools registered", path)
    : check(
        "FAIL",
        "mcp tools registered",
        `${path} has a "${MCP_SERVER_KEY}" server, but not the one crosscheck init writes — rerun crosscheck init`,
      );
};

/** Whether the registered tools have credentials to reach the hub with. */
const mcpUsableCheck = (hasConfig: boolean, hubUrl: string | null): Check =>
  hasConfig
    ? check("PASS", "mcp tools usable", `they will call ${hubUrl ?? "the hub"}`)
    : check(
        "FAIL",
        "mcp tools usable",
        "no hub url or api key, so every tool call answers with an error — run `crosscheck login <hubUrl>`",
      );

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
  return [
    depthCheck,
    ageCheck,
    droppedCheck,
    unclosedCheck,
    await checkFlushLock(home, key),
  ];
};

/**
 * Whether anything is stuck holding the flush lock.
 *
 * The lock refuses to take a claim whose holder process is still running, which
 * is what stops a slow flush being robbed mid-request (spool/lock.ts). A holder
 * that has CRASHED is not running even while its entry is still in the process
 * table: a zombie is retired as dead there and reported as gone here, which is
 * what keeps the commonest crash — a hook that died under a parent still
 * sitting on it — out of the warning below.
 *
 * The state that cannot resolve itself is the narrower one left over: a crashed
 * holder's pid REUSED by an unrelated long-lived process, which is alive, is no
 * zombie, and cannot be told from the holder it replaced. That claim is never
 * retired, and flush and reap are deferred for as long as the impostor lives.
 * Nothing else here would say so — the spool would simply stop draining, and
 * only the depth check would eventually notice, without naming a cause.
 *
 * A claim whose holder is GONE passes: the next acquisition takes it over, so
 * reporting it would be noise. The pid is named because it is the only thing a
 * developer can act on.
 */
const checkFlushLock = async (home: string, key: string): Promise<Check> => {
  const holder = await readLockHolder(spoolFlushLockPath(home, key));
  if (holder === null) {
    return check("PASS", "flush lock", "free");
  }
  const held = formatAge(holder.ageMs);
  if (!holder.isRunning) {
    return check(
      "PASS",
      "flush lock",
      `held ${held} by a holder that is gone — the next flush takes it over`,
    );
  }
  return holder.ageMs > DOCTOR_FLUSH_LOCK_WARN_MS
    ? check(
        "WARN",
        "flush lock",
        `held ${held} by pid ${holder.pid}, which the OS still reports as running — flush and reap are deferred while it is; that pid may be a crosscheck hook stuck inside the lock, a crashed one whose exit this check could not confirm, or an unrelated process that took over a crashed hook's pid, and this repo's spool has stopped draining in every one of those cases`,
      )
    : check("PASS", "flush lock", `held ${held} by pid ${holder.pid}`);
};

/**
 * The team-level version of rule 6: a teammate's connector dying is silent BY
 * DESIGN on their machine, so the place it becomes visible is everyone else's
 * doctor. Counts only, per finding kind — the names belong to `crosscheck
 * status`, where a human asked for the list rather than a health check.
 *
 * "not measured" is a PASS, not a WARN: an older hub without the endpoint (or
 * an unreachable one — the hub check above already reports that) says nothing
 * about THIS install's health, and a warning nobody can act on teaches people
 * to ignore doctor.
 */
const checkAbsences = async (
  ctx: HubContext,
  repoId: string,
): Promise<Check> => {
  const result = await getAbsences(ctx, repoId);
  if (!result.ok) {
    return check("PASS", "absence findings", "not measured");
  }
  if (result.data.length === 0) {
    return check("PASS", "absence findings", "none");
  }
  const inactive = result.data.filter((entry) => entry.kind === "inactive").length;
  const unconnected = result.data.filter(
    (entry) => entry.kind === "unconnected",
  ).length;
  const parts = [
    ...(inactive > 0
      ? [`${inactive} hub member${inactive === 1 ? "" : "s"}`]
      : []),
    ...(unconnected > 0
      ? [`${unconnected} without a crosscheck account`]
      : []),
  ];
  return check(
    "WARN",
    "absence findings",
    `${result.data.length} recent commit author${result.data.length === 1 ? "" : "s"} ` +
      `with no matching reported session (${parts.join(", ")}) — crosscheck status has the lines`,
  );
};

/**
 * Own privacy state (DESIGN.md §2.1), counts only — names belong to
 * `crosscheck status`. Always PASS: both states are deliberate choices, not
 * defects; the check exists so "why does nobody see me" / "why do I never
 * see them" is answered before anyone chases a connector ghost. "not
 * measured" (an older hub, or unreachable) is a PASS for the same reason
 * the absence check's is.
 */
const checkPrivacy = async (ctx: HubContext): Promise<Check> => {
  const result = await getPrivacySettings(ctx);
  if (!result.ok) {
    return check("PASS", "privacy settings", "not measured");
  }
  const presencePart = result.data.presenceOptOut
    ? "presence hidden (opt-out)"
    : "presence visible";
  // Counts only, like the mutes — the addresses belong to `crosscheck
  // status`. An older hub sends no emails field (empty list): no segment,
  // rather than a fabricated zero.
  const aliasCount = result.data.emails.filter(
    (entry) => !entry.isPrimary,
  ).length;
  const aliasPart =
    result.data.emails.length === 0
      ? ""
      : `, ${aliasCount} alias email${aliasCount === 1 ? "" : "s"}`;
  return check(
    "PASS",
    "privacy settings",
    `${presencePart}, ${result.data.mutes.length} muted${aliasPart}`,
  );
};

/**
 * Summarizer cost (DESIGN.md §10 risk 7), always PASS: spending inside the
 * hard caps is a designed behaviour, not a defect — the check exists so the
 * spend on the developer's own quota is never invisible. Figures are
 * estimates (~4 chars/token) and the line says so.
 */
const checkSummarizerCost = async (
  home: string,
  hubUrl: string,
  repoId: string,
): Promise<Check> => {
  const cost = await readSummarizerCost(home, hubUrl, repoId);
  return check("PASS", "summarizer cost", formatSummarizerCost(cost));
};

/**
 * The effective per-request timeout and WHO set it — the source tells the
 * reader which knob moves it: the default is raised by `crosscheck login`
 * (measured) or CROSSCHECK_TIMEOUT_MS; a hand-set stored value is theirs to
 * edit; login rewrites only values it measured itself (timeout-policy.ts).
 */
const TIMEOUT_SOURCE_LABELS: Readonly<Record<TimeoutOwner, string>> = {
  env: "CROSSCHECK_TIMEOUT_MS",
  login: "stored config, measured at login",
  manual: "stored config, set by hand",
  none: "default",
};

const timeoutCheck = (effectiveTimeoutMs: number, owner: TimeoutOwner): Check =>
  check(
    "PASS",
    "timeout",
    `${String(effectiveTimeoutMs)} ms (${TIMEOUT_SOURCE_LABELS[owner]})`,
  );

/** Measures the hub's distance; injectable so tests never time real network. */
export type MeasureLatency = (
  ctx: HubContext,
) => Promise<LatencyMeasurement | null>;

/**
 * Probes wait LATENCY_PROBE_TIMEOUT_MS (a human is watching), not the
 * effective timeout — a hub SLOWER than the effective timeout is exactly the
 * state the WARN below exists to name, so the probe must outlast it.
 * repoKey "" keeps the probes out of the last-sync record, like login's.
 */
const defaultMeasureLatency: MeasureLatency = (ctx) =>
  measureHubLatency(
    async () =>
      (
        await hubRequest(
          { ...ctx, timeoutMs: LATENCY_PROBE_TIMEOUT_MS, repoKey: "" },
          {
            method: "GET",
            path: `/api/presence?repo=${encodeURIComponent(PROBE_REPO)}`,
            schema: z.unknown(),
          },
        )
      ).ok,
    () => Date.now(),
  );

/**
 * The WARN's remedy must name a knob that actually moves THIS timeout.
 * "Rerun crosscheck login" is a guaranteed no-op for an env or hand-set
 * owner (the policy keeps both, config/timeout-policy.ts) and for a
 * login-measured value the recommendation can no longer exceed — advising it
 * would loop: WARN, rerun, identical WARN.
 */
const flapRemedy = (
  owner: TimeoutOwner,
  medianRttMs: number,
  effectiveTimeoutMs: number,
): string => {
  if (owner === "env") {
    return "raise CROSSCHECK_TIMEOUT_MS";
  }
  if (owner === "manual") {
    return "raise your hand-set timeoutMs in config.json (login never rewrites it), or set CROSSCHECK_TIMEOUT_MS";
  }
  // "none" always improves (any WARN-able median recommends above the
  // default); a login-measured value improves until the recommendation hits
  // the cap it is already stored at.
  return recommendedTimeoutMs(medianRttMs) > effectiveTimeoutMs
    ? "rerun crosscheck login to store a measured timeout, or set CROSSCHECK_TIMEOUT_MS"
    : `login already stores its cap (${String(LATENCY_TIMEOUT_MAX_MS)} ms); set CROSSCHECK_TIMEOUT_MS`;
};

/**
 * The honest half of the latency-aware timeout: when the hub sits within the
 * flap margin, the FIRST casualties are the surfaces that fail open silently
 * (prompt hints, the tripwire — silence over delay, hook budgets being ratios
 * of this same timeout), so nothing else on this machine would say why they
 * went quiet. This line is where that state becomes a sentence, with a remedy
 * that fits who owns the timeout — and when the median itself is past the
 * timeout, it says the incident's name ("calls die") rather than "may flap".
 */
const latencyCheck = (
  measurement: LatencyMeasurement | null,
  effectiveTimeoutMs: number,
  owner: TimeoutOwner,
): Check => {
  if (measurement === null) {
    return check("PASS", "hub latency", "not measured");
  }
  const distance = `hub is ${String(measurement.medianRttMs)} ms away, timeout ${String(effectiveTimeoutMs)} ms`;
  if (!isFlapRisk(measurement.medianRttMs, effectiveTimeoutMs)) {
    return check("PASS", "hub latency", distance);
  }
  const consequence =
    measurement.medianRttMs >= effectiveTimeoutMs
      ? "past the timeout, calls die as unreachable"
      : "calls may flap";
  const remedy = flapRemedy(owner, measurement.medianRttMs, effectiveTimeoutMs);
  return check(
    "WARN",
    "hub latency",
    `${distance} — ${consequence}: in-session hints go silent first (hooks fail open — silence over delay), briefings and cli follow; ${remedy}`,
  );
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

export const runDoctor = async (
  env: Env,
  cwd: string,
  measureLatency: MeasureLatency = defaultMeasureLatency,
  agentProbe?: AgentProcessProbe,
): Promise<CliResult> => {
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
    // The MCP checks belong in THIS branch too, and leaving them out was the
    // first version's bug: a developer with no key would have been told the hub
    // was unconfigured and nothing at all about the tools, which is the exact
    // silence rule 6 exists against.
    return summarize([
      configCheck,
      identityCheck,
      check("FAIL", "hub reachable", "no hub configured"),
      ...(identity === null
        ? []
        : [await checkMcpRegistration(identity.root)]),
      mcpUsableCheck(config !== null, config?.hubUrl ?? null),
      bunfigCheck,
    ]);
  }

  const key = repoKey(config.hubUrl, identity.repoId);
  const hubCtx: HubContext = {
    hubUrl: config.hubUrl,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    home: config.home,
    repoKey: key,
    now: () => now,
  };
  const probe = await hubRequest(hubCtx, {
    method: "GET",
    path: `/api/presence?repo=${encodeURIComponent(PROBE_REPO)}`,
    schema: z.unknown(),
  });
  // A connection-level failure names what actually happened and the remedy
  // that moves it (http/connection-error.ts) — "unreachable" hid a plain
  // timeout for an hour of a real onboarding. The bounded DNS refinement is
  // fine here: doctor is a human-run command, not a hook.
  const hubCheck = probe.ok
    ? check("PASS", "hub reachable", config.hubUrl)
    : check(
        "FAIL",
        "hub reachable",
        probe.status === HTTP_UNAUTHORIZED
          ? "invalid api key"
          : probe.kind === "network"
            ? describeConnectionFailure(
                await refineRefusedCause(probe.cause ?? "unknown", config.hubUrl),
                { hubUrl: config.hubUrl, timeoutMs: config.timeoutMs },
                probe.message,
              )
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

  // Measured when the hub answered OR when the probe died network-shaped: the
  // reachability probe runs at the TIGHT effective timeout, so a hub past that
  // timeout — the incident this feature exists for — fails it, and the patient
  // probes (LATENCY_PROBE_TIMEOUT_MS) are the only way its distance still gets
  // printed with the remedies. A refused or dead hub fails those probes too,
  // instantly, degrading to null ("not measured"); an answered denial
  // (http/malformed) is the reachability FAIL's story alone.
  const measurement =
    probe.ok || probe.kind === "network" ? await measureLatency(hubCtx) : null;

  const owner = timeoutOwner(env, config.stored);
  const settingsInspection = await checkSettings(identity.root);
  return summarize([
    configCheck,
    identityCheck,
    hubCheck,
    timeoutCheck(config.timeoutMs, owner),
    latencyCheck(measurement, config.timeoutMs, owner),
    ...settingsInspection.checks,
    ...(settingsInspection.launcherCommand === null
      ? []
      : [await checkLauncher(settingsInspection.launcherCommand, env)]),
    await checkAgentRestart(
      identity.root,
      join(identity.root, CLAUDE_SETTINGS_DIR, CLAUDE_SETTINGS_FILE),
      agentProbe ?? defaultAgentProbe(cwd),
      now.getTime(),
    ),
    await checkMcpRegistration(identity.root),
    mcpUsableCheck(true, config.hubUrl),
    ...(await checkSpool(config.home, key, now)),
    await checkSummarizerCost(config.home, config.hubUrl, identity.repoId),
    await checkLastSync(config.home, key, now),
    await checkAbsences(hubCtx, identity.repoId),
    await checkPrivacy(hubCtx),
    skewCheck,
    bunfigCheck,
    ...(await checkCursor(identity.root, env, config.home, key)),
  ]);
};

/**
 * The Cursor section (design §3.4), owned by connector-cursor: hooks file +
 * entries + launcher + mcp entry + observed version + contract-drift
 * counters. DYNAMIC import like the bin's cursor-hook branch, and its
 * failure is contained — a broken cursor package must cost its section,
 * never the doctor.
 */
const checkCursor = async (
  repoRoot: string,
  env: Env,
  home: string,
  key: string,
): Promise<readonly Check[]> => {
  try {
    const { cursorDoctorChecks } = await import(
      "@crosscheck/connector-cursor"
    );
    const checks = await cursorDoctorChecks({ repoRoot, env, home, repoKey: key });
    return checks.map((entry) => check(entry.level, entry.name, entry.detail));
  } catch {
    return [
      check("WARN", "cursor hooks", "cursor section unavailable (connector-cursor failed to load)"),
    ];
  }
};
