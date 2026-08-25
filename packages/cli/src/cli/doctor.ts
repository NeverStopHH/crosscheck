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
  DOCTOR_HOOK_SILENT_WARN_MINUTES,
  DOCTOR_MCP_PROBE_TIMEOUT_MS,
  DOCTOR_NO_PROBE_ENV,
  DOCTOR_LAST_SYNC_WARN_MINUTES,
  DOCTOR_SPOOL_AGE_WARN_HOURS,
  DOCTOR_SPOOL_DEPTH_FAIL,
  DOCTOR_SPOOL_DEPTH_WARN,
  DOCTOR_STATUSLINE_SILENT_WARN_MINUTES,
  DOCTOR_ZOMBIE_STATE_WARN_HOURS,
  EXIT_FAIL,
  GIT_TIMEOUT_MS,
  HTTP_NOT_FOUND,
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
  REGISTERED_HOOK_EVENTS,
  REPO_CONFIG_FILE,
  REGISTERED_HOOK_EVENT_NAMES,
  SECONDS_PER_MINUTE,
  SESSION_STATE_SCAN_MAX_FILES,
  SUMMARIZER_CLAUDE_MIN_VERSION,
} from "@crosscheck/connector-core/constants.ts";
import { loadConfig } from "@crosscheck/connector-core/config/config.ts";
import { timeoutOwner } from "@crosscheck/connector-core/config/timeout-policy.ts";
import type { TimeoutOwner } from "@crosscheck/connector-core/config/timeout-policy.ts";
import {
  configPath,
  crosscheckHome,
  readJsonOrNull,
  readTextOrNull,
  repoKey,
  spoolFlushLockPath,
} from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { formatAge } from "@crosscheck/connector-core/briefing/render.ts";
import { realpathBestEffort } from "@crosscheck/connector-core/config/paths.ts";
import { hasGitEntry } from "@crosscheck/connector-core/config/connected-repo.ts";
import { readRepoConfig } from "@crosscheck/connector-core/config/repo-config.ts";
import {
  formatForeignDropLine,
  readForeignRepoDrops,
} from "@crosscheck/connector-core/state/foreign-drops.ts";
import { isPathIgnored } from "@crosscheck/connector-core/git/check-ignore.ts";
import { runBoundedCommand } from "@crosscheck/connector-core/git/git.ts";
import { resolveRepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import { hubRequest } from "@crosscheck/connector-core/http/client.ts";
import type { HubContext, HubFailureKind } from "@crosscheck/connector-core/http/client.ts";
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
import {
  getAbsences,
  getHintStats,
  getOpenSessions,
  getPrivacySettings,
} from "@crosscheck/connector-core/http/hub.ts";
import type { HintStats } from "@crosscheck/connector-core/http/hub.ts";
import { readDropSummary, readUnrecordedDrop } from "@crosscheck/connector-core/spool/drops.ts";
import {
  countCursorIdentityMismatches,
  oldestSpoolLineMs,
  spoolDepth,
} from "@crosscheck/connector-core/spool/files.ts";
import { readLockHolder } from "@crosscheck/connector-core/spool/lock.ts";
import { readUnclosedSummary } from "@crosscheck/connector-core/spool/unclosed.ts";
import {
  readHooksFired,
  readStatuslineRendered,
} from "@crosscheck/connector-core/state/fired-markers.ts";
import {
  heartbeatAgeMs,
  listSessionStateFiles,
} from "@crosscheck/connector-core/state/session-scan.ts";
import { SessionStateSchema } from "@crosscheck/connector-core/state/session-state.ts";
import { readSyncState } from "@crosscheck/connector-core/state/sync-state.ts";
import { checkLauncherCommand } from "@crosscheck/connector-core/config/launcher-check.ts";
import {
  formatSummarizerCost,
  formatSummarizerFailure,
  isBelowSummarizerVersionFloor,
  isSummarizerSilentlyDead,
  probeSummarizerRunner,
  readSummarizerCost,
} from "@crosscheck/connector-claude";
import type {
  SummarizerFailure,
  SummarizerProbe,
} from "@crosscheck/connector-claude";
import { isOwnedMcpEntry } from "@crosscheck/connector-core/config/mcp-config.ts";
import type { McpServerEntry } from "@crosscheck/connector-core/config/mcp-config.ts";
import { claudeUserMcpPath, isOwnedCommand } from "@crosscheck/connector-claude";
import {
  globalInstallChecks,
  ownedHookEntries,
  readGlobalWiring,
  readProjectWiring,
} from "./doctor-global.ts";
import type { GlobalWiring } from "./doctor-global.ts";
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

/**
 * Hook events a healthy install registers — project and user scope alike.
 *
 * Read from core (constants.ts REGISTERED_HOOK_EVENTS) rather than spelled a
 * second time here: this list, `buildSettingsPlan`'s and the contract
 * watcher's had drifted apart, and the watcher's copy — three events where
 * this one has six — is what left the PreToolUse tripwire's output contract
 * unwatched (trial finding M17).
 */
const REQUIRED_HOOK_EVENTS = REGISTERED_HOOK_EVENT_NAMES;

/**
 * Whether the user-scope install registers every hook the project check
 * requires — the condition under which a repo with no project hooks is
 * still fully wired (finding #13: the project checks predate `init
 * --global` and read a healthy global-only machine as broken).
 */
const globalCoversHooks = (wiring: GlobalWiring): boolean =>
  REQUIRED_HOOK_EVENTS.every((event) => wiring.hookEvents.includes(event));

/**
 * The hooks line when the PROJECT scope registers nothing: PASS when user
 * scope satisfies the requirement (saying which scope did), FAIL naming
 * the incomplete user-scope install when it half does, and the exact
 * project-scope FAIL (`projectDetail`) when NEITHER scope is wired.
 */
const hooksViaScopes = (wiring: GlobalWiring, projectDetail: string): Check => {
  if (globalCoversHooks(wiring)) {
    return check(
      "PASS",
      "hooks registered",
      `via global install — ${wiring.settingsPath} (user scope)`,
    );
  }
  if (wiring.hookEvents.length > 0) {
    const missing = REQUIRED_HOOK_EVENTS.filter(
      (event) => !wiring.hookEvents.includes(event),
    );
    return check(
      "FAIL",
      "hooks registered",
      `user-scope hooks in ${wiring.settingsPath} are missing: ${missing.join(", ")} — rerun crosscheck init --global`,
    );
  }
  return check("FAIL", "hooks registered", projectDetail);
};

/** The statusline line when the project scope sets none — user scope applies. */
const statuslineViaGlobal = (wiring: GlobalWiring, noneDetail: string): Check =>
  wiring.statuslineCommand === null
    ? check("WARN", "statusline registered", noneDetail)
    : isOwnedCommand(wiring.statuslineCommand)
      ? check(
          "PASS",
          "statusline registered",
          `via global install — ${wiring.statuslineCommand}`,
        )
      : check(
          "WARN",
          "statusline registered",
          `foreign statusline (user scope): ${wiring.statuslineCommand}`,
        );

const checkSettings = async (
  repoRoot: string,
  global: GlobalWiring,
): Promise<SettingsInspection> => {
  const path = join(repoRoot, CLAUDE_SETTINGS_DIR, CLAUDE_SETTINGS_FILE);
  const raw = await readTextOrNull(path);
  if (raw === null) {
    return settingsOnly([
      hooksViaScopes(global, `${path} not found — run crosscheck init`),
      statuslineViaGlobal(global, "no settings file"),
    ]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    // A corrupt PROJECT file stays a FAIL whatever user scope says: the
    // file needs a human whichever scope runs the hooks.
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

  const ownedCommands = ownedHookEntries(
    settings.data as Record<string, unknown>,
  );

  const missing = REQUIRED_HOOK_EVENTS.filter(
    (event) => !ownedCommands.some((entry) => entry.event === event),
  );
  const unexpected = ownedCommands.filter(
    (entry) => !(REQUIRED_HOOK_EVENTS as readonly string[]).includes(entry.event),
  );
  const hooksCheck =
    ownedCommands.length === 0
      ? // The statusLine-only shape (finding #13's second variant): the
        // project file exists but registers no crosscheck hooks at all, so
        // the question falls through to user scope exactly as if the file
        // were absent.
        hooksViaScopes(global, `missing: ${missing.join(", ")}`)
      : missing.length > 0
        ? check("FAIL", "hooks registered", `missing: ${missing.join(", ")}`)
        : unexpected.length > 0
          ? check(
              "WARN",
              "hooks registered",
              `unexpected crosscheck entries: ${unexpected.map((entry) => entry.event).join(", ")}`,
            )
          : check("PASS", "hooks registered", REQUIRED_HOOK_EVENTS.join(", "));

  const statuslineCommand = settings.data.statusLine?.command;
  const statuslineCheck =
    statuslineCommand === undefined
      ? statuslineViaGlobal(global, "no statusline configured")
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
 * ── Workspace-root check (trial finding #9) ────────────────────────────────
 *
 * A developer whose editor workspace is rooted at the PARENT folder of the
 * repo (~/dev above ~/dev/monorepo) has panel sessions start with cwd at
 * the workspace root — where there is no repo config — and those sessions
 * were silently invisible while terminal sessions reported fine. The
 * capture side now derives the repo from the touched file
 * (connector-core/config/connected-repo.ts), but the SessionStart briefing
 * and presence still only begin at the first file touch — so when doctor is
 * run in exactly that spot, it says so instead of printing an unexplained
 * "not a git repository". One level deep, bounded entries, read-only.
 */
const DOCTOR_SUBDIR_SCAN_MAX_ENTRIES = 200;
const DOCTOR_SUBDIR_MAX_NAMED = 3;

const connectedSubdirs = async (cwd: string): Promise<readonly string[]> => {
  try {
    const entries = await readdir(cwd, { withFileTypes: true });
    const hits: string[] = [];
    for (const entry of entries.slice(0, DOCTOR_SUBDIR_SCAN_MAX_ENTRIES)) {
      if (!entry.isDirectory()) {
        continue;
      }
      // BOTH marks, exactly as the capture walk requires (connected-repo.ts):
      // a config without a git boundary never connects, so calling it a
      // "connected repo" here would hand out advice the walk cannot honour.
      const subdir = join(cwd, entry.name);
      if (
        (await hasGitEntry(subdir)) &&
        (await readRepoConfig(subdir)) !== null
      ) {
        hits.push(entry.name);
        if (hits.length >= DOCTOR_SUBDIR_MAX_NAMED) {
          break;
        }
      }
    }
    return hits;
  } catch {
    return [];
  }
};

/**
 * Emitted only when the cwd is NOT a connected repo but a DIRECT
 * subdirectory is — the exact "workspace above the repo" spot. Empty
 * findings render nothing: a plain folder above nothing connected is not
 * news, and inside a connected repo the check does not run at all.
 */
const workspaceRootChecks = async (cwd: string): Promise<readonly Check[]> => {
  const subdirs = await connectedSubdirs(cwd);
  if (subdirs.length === 0) {
    return [];
  }
  const first = subdirs[0] ?? "";
  const others =
    subdirs.length > 1 ? ` (also: ${subdirs.slice(1).join(", ")})` : "";
  return [
    check(
      "WARN",
      "workspace root",
      `you are above the connected repo ${first} — sessions starting here are invisible until they touch a file inside it; open ${first} as your workspace${others}`,
    ),
  ];
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
  /**
   * Working directories for a whole batch of pids at once — a pid missing
   * from the map is one whose cwd could not be known.
   *
   * It used to be one pid per call, and on macOS one call was one `lsof`
   * spawn, which is why the candidate list was capped at eight. That cap was
   * then spent on desktop-app helpers (below) before a real agent was ever
   * reached. `lsof` takes a comma-separated pid list, so the whole batch is
   * ONE spawn regardless of size and the cap now bounds only the parse.
   */
  readonly resolveCwds: (
    pids: readonly number[],
  ) => Promise<ReadonlyMap<number, string>>;
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
  /** Full `ps comm` path — what the desktop-helper exclusion reads. */
  readonly command: string;
  readonly startedAtMs: number;
}

/**
 * A macOS application BUNDLE's internal executables.
 *
 * Measured on the author's Mac during the trial audit: 23 processes whose
 * `ps comm` basenames to `claude`, twelve or more of them
 * `/Applications/Claude.app/Contents/MacOS/…` and
 * `/Applications/Claude.app/Contents/Frameworks/…` — the desktop app and its
 * helpers, which are not coding agents, do not load our hooks and whose cwd is
 * `/`. They arrive in ps order, so with the old cap of eight they consumed the
 * entire candidate budget and a real offender at position 25 was never looked
 * at: `PASS no running agent predates the hooks`, with the agent running.
 */
const APP_BUNDLE_PATTERN = /\.app\/Contents\//;

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
  const command = commTokens.join(" ");
  const name = basename(command).toLowerCase();
  if (!AGENT_PROCESS_NAMES.has(name)) {
    return null;
  }
  return {
    pid,
    name,
    command,
    startedAtMs: nowMs - elapsedSeconds * MS_PER_SECOND,
  };
};

const isInsideRepo = async (repoRoot: string, cwd: string): Promise<boolean> => {
  const root = await realpathBestEffort(repoRoot);
  const resolved = await realpathBestEffort(cwd);
  const rel = relative(root, resolved);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
};

/**
 * The NEWEST settings file that carries hooks, and its name.
 *
 * It used to be exactly one path — this repo's `.claude/settings.json` — and
 * that was wrong in both directions (trial finding H6). In a fresh worktree
 * the file does not exist, so the whole check read `PASS not measured (no
 * settings file)` while a global install's `~/.claude/settings.json` carried
 * all six hooks and had been rewritten ten minutes ago. And in a repo that
 * DOES have one, an 88-byte statusLine-only stub from days earlier was what
 * got measured, while the file that actually holds the hooks — the user-scope
 * one — was newer and never stat'ed. Whichever file was written LAST is the
 * one an already-running agent can be older than, so that is the one measured,
 * and its path goes in the sentence so the reader knows which file is meant.
 */
const newestSettingsFile = async (
  paths: readonly string[],
): Promise<{ readonly path: string; readonly mtimeMs: number } | null> => {
  const stats = await Promise.all(
    paths.map(async (path) =>
      stat(path).then(
        (info) => ({ path, mtimeMs: info.mtimeMs }),
        () => null,
      ),
    ),
  );
  return stats
    .filter((entry): entry is { path: string; mtimeMs: number } => entry !== null)
    .reduce<{ path: string; mtimeMs: number } | null>(
      (newest, entry) =>
        newest === null || entry.mtimeMs > newest.mtimeMs ? entry : newest,
      null,
    );
};

export const checkAgentRestart = async (
  repoRoot: string,
  settingsPaths: readonly string[],
  probe: AgentProcessProbe,
  nowMs: number,
): Promise<Check> => {
  const name = "agent restart";
  try {
    const settings = await newestSettingsFile(settingsPaths);
    if (settings === null) {
      return check("PASS", name, "not measured (no settings file)");
    }
    const raw = await probe.listProcesses();
    if (raw === null) {
      return check("PASS", name, "not measured");
    }
    const matched = raw
      .split("\n")
      .slice(0, DOCTOR_AGENT_PS_MAX_LINES)
      .flatMap((line) => {
        const parsed = parsePsLine(line, nowMs);
        return parsed === null || parsed.startedAtMs >= settings.mtimeMs
          ? []
          : [parsed];
      });
    // Desktop-app helpers out, then NEWEST-STARTED FIRST, then the cap. The
    // order is the whole point: ps order is arbitrary, so a truncation that
    // happens in it drops candidates at random, and the ones worth keeping
    // are the ones that started closest to the settings write.
    const eligible = matched.filter(
      (candidate) => !APP_BUNDLE_PATTERN.test(candidate.command),
    );
    const candidates = [...eligible]
      .sort((left, right) => right.startedAtMs - left.startedAtMs)
      .slice(0, DOCTOR_AGENT_MAX_CWD_PROBES);
    const skipped = matched.length - candidates.length;
    // ONE call for every pid: on macOS that is a single `lsof`, so the number
    // of candidates no longer costs spawns.
    const cwds = await probe
      .resolveCwds(candidates.map((candidate) => candidate.pid))
      .catch(() => new Map<number, string>());
    const offenders: AgentCandidate[] = [];
    for (const candidate of candidates) {
      const cwd = cwds.get(candidate.pid);
      if (cwd !== undefined && (await isInsideRepo(repoRoot, cwd))) {
        offenders.push(candidate);
      }
    }
    // Both branches carry the counts: a PASS whose reader cannot tell whether
    // anything was examined is the shape this whole finding is about.
    const counts = `${String(candidates.length)} agent${candidates.length === 1 ? "" : "s"} checked, ${String(skipped)} skipped`;
    if (offenders.length === 0) {
      return check(
        "PASS",
        name,
        `no running agent predates ${settings.path} — ${counts}`,
      );
    }
    const listed = offenders
      .map((entry) => `pid ${String(entry.pid)} (${entry.name})`)
      .join(", ");
    return check(
      "WARN",
      name,
      `a running agent predates your hooks — restart it: ${listed} in this repo started before ${settings.path} was written, and hooks load only at process start — ${counts}`,
    );
  } catch {
    // Never crashes doctor: any surprise is a "not measured", not a report.
    return check("PASS", name, "not measured");
  }
};

/**
 * `lsof -Fn` field output for a batch of pids, as a map.
 *
 * The format repeats `p<pid>` / `f<fd>` / `n<path>`, so a `n` line belongs to
 * whichever `p` line most recently preceded it — which is why the parser
 * carries the current pid forward instead of reading pairs. Only the `cwd`
 * descriptor is requested (`-d cwd`), so the first `n` per pid is the one
 * wanted; a later duplicate never overwrites it.
 */
export const parseLsofCwds = (output: string): ReadonlyMap<number, string> => {
  const cwds = new Map<number, string>();
  let pid: number | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      const parsed = Number.parseInt(line.slice(1), 10);
      pid = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
      continue;
    }
    if (line.startsWith("n") && pid !== null && !cwds.has(pid)) {
      cwds.set(pid, line.slice(1));
    }
  }
  return cwds;
};

/** The real probe: ps once, then /proc (Linux) or ONE batched lsof (macOS). */
const defaultAgentProbe = (cwd: string): AgentProcessProbe => ({
  listProcesses: async () =>
    process.platform === "linux" || process.platform === "darwin"
      ? runBoundedCommand(
          ["ps", "-axo", "pid=,etime=,comm="],
          cwd,
          DOCTOR_AGENT_PS_TIMEOUT_MS,
        )
      : null,
  resolveCwds: async (pids) => {
    if (pids.length === 0) {
      return new Map<number, string>();
    }
    if (process.platform === "linux") {
      // No spawn at all here: /proc is a readlink each, which is why Linux
      // never needed the batching macOS does.
      const entries = await Promise.all(
        pids.map(async (pid): Promise<readonly [number, string] | null> => {
          try {
            return [pid, await readlink(`/proc/${String(pid)}/cwd`)] as const;
          } catch {
            return null;
          }
        }),
      );
      return new Map(
        entries.filter((entry): entry is readonly [number, string] => entry !== null),
      );
    }
    if (process.platform === "darwin") {
      const output = await runBoundedCommand(
        ["lsof", "-a", "-p", pids.join(","), "-d", "cwd", "-Fn"],
        cwd,
        DOCTOR_AGENT_CWD_TIMEOUT_MS,
      );
      return output === null ? new Map<number, string>() : parseLsofCwds(output);
    }
    return new Map<number, string>();
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
/**
 * The sentence that turns a committed-file recommendation into a lie when the
 * file is gitignored (trial finding M11). Empty when git says it is not
 * ignored, and empty when git could not say — old text over wrong text.
 */
const ignoredSuffix = (ignored: boolean | null, path: string): string =>
  ignored === true
    ? ` — WARNING: ${path} is gitignored in this repo, so committing it is impossible and teammates never receive it; they need \`crosscheck init --global\` on their own machines`
    : "";

const checkMcpRegistration = async (
  repoRoot: string,
  userScopeRegistered: boolean,
  mcpIgnored: boolean | null,
): Promise<Check> => {
  const path = join(repoRoot, MCP_CONFIG_FILE);
  const raw = await readTextOrNull(path);
  if (raw === null) {
    // Finding #13: a missing PROJECT file is not a broken install when the
    // user scope registers the tools — but user scope covers only THIS
    // machine, so the committed-file advice survives as a note instead of
    // being lost with the FAIL.
    if (userScopeRegistered) {
      return mcpIgnored === true
        ? check(
            "WARN",
            "mcp tools registered",
            `via global install (user scope, this machine only) — ${path} is gitignored here, so the committed-file route does not exist in this repo and teammates need \`crosscheck init --global\` on their own machines`,
          )
        : check(
            "PASS",
            "mcp tools registered",
            `via global install (user scope, this machine only) — teammates get the tools from a committed ${path}: run crosscheck init, then commit the file`,
          );
    }
    return check(
      "FAIL",
      "mcp tools registered",
      `${path} not found — run crosscheck init, then commit the file so teammates get the tools too${ignoredSuffix(mcpIgnored, path)}`,
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
  if (isOwnedMcpEntry(entry)) {
    return mcpIgnored === true
      ? check(
          "WARN",
          "mcp tools registered",
          `${path}${ignoredSuffix(mcpIgnored, path)}`,
        )
      : check("PASS", "mcp tools registered", path);
  }
  return check(
    "FAIL",
    "mcp tools registered",
    `${path} has a "${MCP_SERVER_KEY}" server, but not the one crosscheck init writes — rerun crosscheck init`,
  );
};

/**
 * ── "mcp tools usable" (trial finding M3) ──────────────────────────────────
 *
 * This line used to be `mcpUsableCheck(hasConfig, hubUrl)`, called as
 * `mcpUsableCheck(true, config.hubUrl)` — a literal constant in the branch
 * where a config exists, so it printed `PASS mcp tools usable  they will call
 * <url>` unconditionally, and during the trial it printed exactly that
 * directly beneath `FAIL hub reachable  invalid api key`. "Usable" is a claim
 * about credentials and a claim about the server starting, and it made
 * neither.
 *
 * The KEY verdict comes from the HUB PROBE, which doctor has already run.
 * The spawn below proves something different and narrower, and the comment on
 * `probeMcpServer` says exactly what.
 */
export type McpProbeOutcome =
  | { readonly kind: "not-probed"; readonly why: string }
  | { readonly kind: "answered"; readonly tools: number }
  | { readonly kind: "failed"; readonly detail: string };

export interface McpUsableFacts {
  /** A hub url and api key exist at all. */
  readonly configured: boolean;
  readonly hubUrl: string | null;
  /** Doctor's own reachability probe — null in the unconfigured branch. */
  readonly hub: { readonly ok: boolean; readonly status: number; readonly kind: HubFailureKind } | null;
  /** Registered in EITHER scope: an unregistered tool is never called. */
  readonly registered: boolean;
  readonly probe: McpProbeOutcome;
}

/** PURE, so every branch's wording is pinned without spawning anything. */
export const mcpUsableCheck = (facts: McpUsableFacts): Check => {
  const name = "mcp tools usable";
  if (!facts.configured) {
    return check(
      "FAIL",
      name,
      "no hub url or api key, so every tool call answers with an error — run `crosscheck login <hubUrl>`",
    );
  }
  const hubUrl = facts.hubUrl ?? "the hub";
  if (facts.hub !== null && !facts.hub.ok) {
    // The credential verdict, taken from the call that actually presented the
    // credential. A 401 is an ANSWER — the hub is there and the key is not
    // welcome — and it has its own command, which is why it is not folded in
    // with the outage below.
    if (facts.hub.status === HTTP_UNAUTHORIZED) {
      return check(
        "FAIL",
        name,
        `api key rejected — every tool call will answer with an error: run \`crosscheck login ${hubUrl}\``,
      );
    }
    return check(
      "WARN",
      name,
      `${hubUrl} is unreachable from here, so the tools will error on every call — see the hub reachable line above for what to fix`,
    );
  }
  if (!facts.registered) {
    return check(
      "FAIL",
      name,
      "no mcp server is registered in either scope, so no agent can call the tools — run `crosscheck init` (or `crosscheck init --global`)",
    );
  }
  switch (facts.probe.kind) {
    case "failed":
      return check(
        "FAIL",
        name,
        `the registered mcp server did not answer: ${facts.probe.detail} — the launcher in the registration cannot start crosscheck`,
      );
    case "answered":
      return check(
        "PASS",
        name,
        `${String(facts.probe.tools)} tools, and they will call ${hubUrl}`,
      );
    case "not-probed":
      return check("PASS", name, `not probed (${facts.probe.why}) — they will call ${hubUrl}`);
  }
};

/** JSON-RPC ids used by the handshake; only the second one is read back. */
const MCP_PROBE_INIT_ID = 1;
const MCP_PROBE_LIST_ID = 2;

const McpToolsResultSchema = z.looseObject({
  id: z.number(),
  result: z.looseObject({ tools: z.array(z.unknown()) }),
});

/**
 * Spawns the REGISTERED mcp entry and speaks two frames to it.
 *
 * WHAT THIS PROVES, precisely: that the command in `.mcp.json` (or the user
 * scope) STARTS and speaks the protocol. That is a real failure mode — a
 * launcher whose path no longer resolves, an import that crashes, a wrapper
 * script that exits — and nothing else on the machine reports it, because an
 * agent that cannot start the server simply has no tools and says nothing.
 *
 * WHAT IT DOES NOT PROVE: credentials. `tools/list` is answered from a static
 * table (mcp/server.ts `listToolsResult`), so it succeeds with no api key, a
 * rotated one, or a dead hub. The key verdict is the hub probe's, above, and
 * the branch order in `mcpUsableCheck` reflects that.
 *
 * stdin is `"pipe"` and CLOSED after the two frames: the server's stdio loop
 * ends when stdin ends, so the child cannot outlive the probe. `timeout` is a
 * second guard for a child that ignores both.
 */
const probeMcpServer = async (
  entry: McpServerEntry,
  cwd: string,
): Promise<McpProbeOutcome> => {
  try {
    const child = Bun.spawn({
      cmd: [entry.command, ...entry.args],
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      timeout: DOCTOR_MCP_PROBE_TIMEOUT_MS,
    });
    const frames =
      `${JSON.stringify({ jsonrpc: "2.0", id: MCP_PROBE_INIT_ID, method: "initialize", params: {} })}\n` +
      `${JSON.stringify({ jsonrpc: "2.0", id: MCP_PROBE_LIST_ID, method: "tools/list", params: {} })}\n`;
    child.stdin.write(frames);
    await child.stdin.end();
    const stdout = await new Response(child.stdout).text();
    await child.exited;
    for (const line of stdout.split("\n")) {
      if (line.trim().length === 0) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      const listed = McpToolsResultSchema.safeParse(parsed);
      if (listed.success && listed.data.id === MCP_PROBE_LIST_ID) {
        return { kind: "answered", tools: listed.data.result.tools.length };
      }
    }
    return {
      kind: "failed",
      detail: `no tools/list answer within ${String(DOCTOR_MCP_PROBE_TIMEOUT_MS)} ms`,
    };
  } catch (error) {
    return {
      kind: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
};

const McpServerEntrySchema = z.looseObject({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
});

/** The entry an agent would actually launch: project scope first, then user. */
const readRegisteredMcpEntry = async (
  repoRoot: string,
  env: Env,
): Promise<McpServerEntry | null> => {
  for (const path of [join(repoRoot, MCP_CONFIG_FILE), claudeUserMcpPath(env)]) {
    const servers = z
      .looseObject({ mcpServers: z.record(z.string(), z.unknown()).optional() })
      .safeParse(await readJsonOrNull(path));
    const raw = servers.success
      ? servers.data.mcpServers?.[MCP_SERVER_KEY]
      : undefined;
    if (!isOwnedMcpEntry(raw)) {
      continue;
    }
    const parsed = McpServerEntrySchema.safeParse(raw);
    if (parsed.success) {
      return { type: "stdio", command: parsed.data.command, args: parsed.data.args };
    }
  }
  return null;
};

/**
 * Gathers the facts. The spawn is skipped under the same env var the
 * summarizer probe honours — doctor is human-run, but a script that loops it
 * must not spawn a server per iteration (§R7).
 */
const checkMcpUsable = async (
  repoRoot: string,
  env: Env,
  facts: Omit<McpUsableFacts, "probe">,
): Promise<Check> => {
  if (!facts.configured || (facts.hub !== null && !facts.hub.ok) || !facts.registered) {
    // Every one of these decides the line on its own, and the spawn would be
    // a process spent on an answer nobody reads.
    return mcpUsableCheck({
      ...facts,
      probe: { kind: "not-probed", why: "the verdict is already decided" },
    });
  }
  if (env[DOCTOR_NO_PROBE_ENV] === "1") {
    return mcpUsableCheck({
      ...facts,
      probe: { kind: "not-probed", why: `${DOCTOR_NO_PROBE_ENV}=1` },
    });
  }
  const entry = await readRegisteredMcpEntry(repoRoot, env);
  return mcpUsableCheck({
    ...facts,
    probe:
      entry === null
        ? { kind: "not-probed", why: "no launchable entry found" }
        : await probeMcpServer(entry, repoRoot),
  });
};

const checkSpool = async (
  home: string,
  key: string,
  now: Date,
  openOnHub: number | null,
): Promise<readonly Check[]> => {
  const depth = await spoolDepth(home, key);
  // WHY those records are pending, when the answer is "this home was copied"
  // (Anhang A, A4-10). The level is still whatever the thresholds decide —
  // this is wording, not a new alarm — but a restored `~/.crosscheck` reports
  // every delivered line as pending (315 phantoms observed on one), and
  // without the sentence that reads exactly like stuck data.
  const mismatches = await countCursorIdentityMismatches(home, key);
  const depthDetail =
    `${depth} pending records` +
    (mismatches === 0
      ? ""
      : ` — cursor identity changed for ${String(mismatches)} session file${mismatches === 1 ? "" : "s"} (this home was copied or restored); those records replay and the hub deduplicates them`);
  const depthCheck =
    depth > DOCTOR_SPOOL_DEPTH_FAIL
      ? check("FAIL", "spool depth", depthDetail)
      : depth > DOCTOR_SPOOL_DEPTH_WARN
        ? check("WARN", "spool depth", depthDetail)
        : check("PASS", "spool depth", depthDetail);

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
  // The second number (trial finding M2): state files whose session stopped
  // heartbeating. Machine-wide, like the foreign-drop scan, because a zombie
  // state file pins its spool against reap whichever repo it belongs to.
  const zombies = await countStaleSessionStates(home, now);
  const expiredPart =
    unclosed.sessions > 0
      ? `${unclosed.sessions} session end${unclosed.sessions === 1 ? "" : "s"} expired undelivered` +
        (Number.isNaN(oldestUnclosedMs)
          ? ""
          : `, oldest ${formatAge(now.getTime() - oldestUnclosedMs)} ago`)
      : "no expired ends";
  const zombiePart =
    zombies.stale > 0
      ? `, ${zombies.stale} of ${zombies.total} session state file${zombies.total === 1 ? "" : "s"} stale >${String(DOCTOR_ZOMBIE_STATE_WARN_HOURS)}h (each one pins its spool file against reap)`
      : "";
  // The HUB's own count when it has the endpoint (M6). A session killed on
  // this machine can leave no local trace while its row stays open on the
  // hub — 104 of the trial hub's 127 were exactly that — so the local marker
  // count is a floor and the hub's number is the fact. An older hub sends
  // null and the line reads as it always did.
  //
  // "WITH NO HEARTBEAT" is load-bearing, not decoration. The endpoint answers
  // only rows that are open AND silent past the reaper's own window
  // (server services/sessions.ts listOpenSessions); an earlier version
  // answered every open row, which includes the session the reader is running
  // right now, so this line WARNed from a developer's first session onward and
  // could never reach PASS while anybody worked (review finding B2-03). The
  // sentence has to say which of the two it means.
  const hubPart =
    openOnHub === null || openOnHub === 0
      ? ""
      : `, hub still holds ${String(openOnHub)} of your sessions open with no heartbeat`;
  const unclosedCheck =
    unclosed.sessions > 0 || zombies.stale > 0 || (openOnHub ?? 0) > 0
      ? check("WARN", "unclosed sessions", `${expiredPart}${zombiePart}${hubPart}`)
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
 * Summarizer cost (DESIGN.md §10 risk 7): spending inside the hard caps is
 * a designed behaviour, not a defect — the check exists so the spend on the
 * developer's own quota is never invisible. Figures are estimates (~4
 * chars/token) and the line says so.
 *
 * WARN, not PASS, on the finding-#14 signature (summarizer/cost.ts
 * isSummarizerSilentlyDead): DOCTOR_SUMMARIZER_SILENT_FIRES_WARN or more
 * fires and not one NONE or draft among them. For a whole trial this line
 * read "PASS 17 runs (0 NONE, 0 drafts)" while every run was dying before
 * the model — fail-open that had become silently dead, with the remedy one
 * check further down.
 *
 * The WARN states the BOOKED fact and points at the probe; it does not
 * assert that the runner is failing NOW. Fires are booked into live session
 * state and stay there until SessionEnd, so after an upgrade or a login the
 * old counts sit right above a runner probe that PASSes — a line saying
 * "the runner is failing" there contradicted the check it pointed at.
 */
const checkSummarizerCost = async (
  home: string,
  hubUrl: string,
  repoId: string,
): Promise<Check> => {
  const cost = await readSummarizerCost(home, hubUrl, repoId);
  const line = formatSummarizerCost(cost);
  return isSummarizerSilentlyDead(cost)
    ? check(
        "WARN",
        "summarizer cost",
        `${line} — ${String(cost.fires)} runs fired, none answered — see the summarizer runner check (these counts are per live session and clear at SessionEnd)`,
      )
    : check("PASS", "summarizer cost", line);
};

/**
 * The remedy a failed runner probe names, by what the binary said — each a
 * DIFFERENT fix, which is why the first output line is printed at all:
 * "Not logged in" is the developer's login, "unknown option" is the CLI's
 * age, a deadline is the machine or the timeout knob.
 */
const summarizerRemedy = (failure: SummarizerFailure): string => {
  if (failure.reason === "timeout") {
    return "a lean run answers in ~9 s: raise CROSSCHECK_SUMMARIZER_TIMEOUT_MS or check the machine's load";
  }
  if (failure.reason === "spawn") {
    return "is claude on the PATH the hooks run with? (CROSSCHECK_SUMMARIZER_CMD overrides the binary)";
  }
  if (/not logged in/i.test(failure.detail)) {
    return "log in once with `claude` in a terminal as this user — the summarizer reuses that login, keychain or API key";
  }
  if (/unknown option/i.test(failure.detail)) {
    return `upgrade Claude Code — the summarizer needs ${SUMMARIZER_CLAUDE_MIN_VERSION} or newer and its lean flags are verified on 2.1.237`;
  }
  return "run the argv by hand; crosscheck status shows the booked failures";
};

const versionPart = (version: string | null): string =>
  version === null ? "" : ` (claude ${version})`;

const seconds = (ms: number): string => `${String(Math.round(ms / MS_PER_SECOND))} s`;

/**
 * The runner line for one probe outcome — PURE, so the rendering is pinned
 * without a binary: PASS names the answer and the time; FAIL names what the
 * binary said and a remedy that fits it — the three real failures seen on
 * 2026-08-21 ("Not logged in", an unknown flag on an old CLI, the deadline)
 * each want a different one.
 */
export const summarizerRunnerCheck = (probe: SummarizerProbe): Check => {
  switch (probe.kind) {
    case "skipped":
      return check("PASS", "summarizer runner", `skipped — ${probe.why}`);
    case "answered": {
      const answer = probe.none
        ? `answered NONE in ${seconds(probe.elapsedMs)}${versionPart(probe.version)}`
        : `answered in ${seconds(probe.elapsedMs)}${versionPart(probe.version)}, not NONE: "${probe.firstLine}" (the runner works; that is model precision)`;
      // A working runner on a CLI below the floor is a WARN, not a PASS:
      // below 2.1.101 `--setting-sources ""` let Claude Code's cleanup
      // ignore cleanupPeriodDays and delete transcripts older than 30 days
      // (core constants SUMMARIZER_CLAUDE_MIN_VERSION says where that is
      // from) — every fire could cost the developer conversation history.
      return isBelowSummarizerVersionFloor(probe.version)
        ? check(
            "WARN",
            "summarizer runner",
            `${answer} — below the ${SUMMARIZER_CLAUDE_MIN_VERSION} floor: on this CLI --setting-sources "" lets Claude Code's background cleanup ignore cleanupPeriodDays and delete transcripts older than 30 days (fixed in ${SUMMARIZER_CLAUDE_MIN_VERSION}); upgrade Claude Code`,
          )
        : check("PASS", "summarizer runner", answer);
    }
    case "empty":
      return check(
        "FAIL",
        "summarizer runner",
        `exit 0 with empty stdout in ${seconds(probe.elapsedMs)}${versionPart(probe.version)} — run the argv by hand`,
      );
    case "failed":
      return check(
        "FAIL",
        "summarizer runner",
        `${formatSummarizerFailure(probe.failure)}${versionPart(probe.version)} — ${summarizerRemedy(probe.failure)}`,
      );
  }
};

/**
 * The active runner probe (trial finding #14; summarizer/probe.ts states the
 * cost and the skips): the real argv, the real worker env, the real cwd, a
 * slice that must answer NONE — rendered by summarizerRunnerCheck.
 */
const checkSummarizerRunner = async (env: Env, home: string): Promise<Check> =>
  summarizerRunnerCheck(await probeSummarizerRunner(env, home));

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

/**
 * Foreign-repo drops (trial finding #9, the counter's READER): first-wins
 * silently drops a multi-repo workspace's touches of its second connected
 * repo, and the count in session state was visible to nobody — the exact
 * silent-invisibility class this finding set out to kill, re-created for
 * the multi-repo variant (adversarial review). Machine-wide scan, because
 * the dropping session is bound to the OTHER repo. Zero renders nothing:
 * the workspace-root check's discipline — no drops is not news.
 */
const foreignDropChecks = async (home: string): Promise<readonly Check[]> => {
  const summary = await readForeignRepoDrops(home);
  if (summary.drops === 0) {
    return [];
  }
  return [check("WARN", "foreign-repo drops", formatForeignDropLine(summary))];
};

/**
 * ── Execution checks (trial findings M2 and H7) ────────────────────────────
 *
 * Eleven of doctor's twenty-six lines could PASS while the thing they name
 * was dead, and they shared one mechanism: they read CONFIGURATION. `hooks
 * registered` parses `.claude/settings.json` and reports what it says;
 * `statusline registered` does the same. Neither can see a launcher that
 * stopped resolving after `nvm use`, a `CROSSCHECK_DISABLED` in the agent's
 * environment, an agent process older than the wiring, or a host that never
 * calls the statusline because the session is headless.
 *
 * The two checks below read the only evidence that settles it: markers the
 * hook runner and the statusline write for themselves
 * (connector-core/state/fired-markers.ts). Configuration and execution stay
 * SEPARATE lines on purpose — they have different fixes, and merging them
 * would send half the readers to the wrong command.
 */

/**
 * Events whose silence is evidence. PreToolUse fires only on a write to a
 * file a teammate is holding and SessionEnd only when a session closes
 * cleanly, so both are legitimately rare — they render an age and never WARN,
 * because a warning nobody can act on is how doctors get ignored.
 *
 * SessionStart is off this list for the same reason, arrived at the other way
 * round: it fires ONCE per session and the marker is per-repo last-writer-
 * wins, so its age is "time since the last session started here", not a health
 * signal. Three hours into one session it read three hours old and the line
 * WARNed — while naming PostToolUse 8s and Stop 30s on the same row, refuting
 * all three causes the sentence offers (review finding B2-05). It still
 * renders an age, and the gate below is a live SESSION STATE, which SessionStart
 * is what writes — so a SessionStart that never fired leaves nothing for these
 * lines to warn about in the first place.
 */
const HOOK_SILENCE_WARN_EVENTS: readonly string[] = [
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
];

export interface HookFireFacts {
  /** Hook subcommand name (`post-tool-use`) → ISO stamp of its last fire. */
  readonly firedAt: Readonly<Record<string, string>>;
  /**
   * How long the oldest live session on this repo has been running, or null
   * when none is (doctor's readLiveRepoSessions).
   *
   * An AGE rather than a boolean, because the never-fired case needs it. A
   * stale marker is only news while something is supposed to be running — and
   * a marker that has never fired at all is only news once a session has been
   * running long enough to have produced it.
   */
  readonly liveSessionAgeMs: number | null;
  readonly nowMs: number;
}

const fireAge = (
  facts: HookFireFacts,
  event: string,
): { readonly label: string; readonly ageMs: number | null } => {
  const iso = facts.firedAt[REGISTERED_HOOK_EVENTS[event as keyof typeof REGISTERED_HOOK_EVENTS]];
  if (iso === undefined) {
    return { label: "never", ageMs: null };
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return { label: "never", ageMs: null };
  }
  return { label: formatAge(facts.nowMs - ms), ageMs: facts.nowMs - ms };
};

/**
 * PURE, so the wording is pinned without a hook process: the async half below
 * only reads the marker file and asks whether a session state exists.
 */
export const hooksFiringCheck = (facts: HookFireFacts): Check => {
  const name = "hooks firing";
  const rendered = REQUIRED_HOOK_EVENTS.map(
    (event) => `${event} ${fireAge(facts, event).label}`,
  ).join(" · ");
  const hasLiveSession = facts.liveSessionAgeMs !== null;
  if (Object.keys(facts.firedAt).length === 0 && !hasLiveSession) {
    // A machine that has never run a session here: nothing has failed, and
    // "SessionStart never · PostToolUse never · …" would only read as alarm.
    return check("PASS", name, "not measured (no hook has fired here yet)");
  }
  const silenceMs = DOCTOR_HOOK_SILENT_WARN_MINUTES * MS_PER_MINUTE;
  const silent = HOOK_SILENCE_WARN_EVENTS.filter((event) => {
    const { ageMs } = fireAge(facts, event);
    if (ageMs !== null) {
      return ageMs > silenceMs;
    }
    // NEVER FIRED is not the same claim as "has not fired in 60 min", and
    // folding the two made a session WARN from its first second: PostToolUse,
    // UserPromptSubmit and Stop have had no opportunity yet, and the sentence
    // blamed three causes the session's own age refutes (review finding
    // B2-L3). It becomes silence once the session has outlived the threshold.
    //
    // The residual, stated rather than implied: a session that only ever READS
    // — no Edit, no Write, no Bash — never fires PostToolUse at all, and an
    // hour in this will name it. UserPromptSubmit and Stop fire in such a
    // session, so the sentence names one event rather than three, and the
    // causes it offers are still the ones worth checking.
    return (facts.liveSessionAgeMs ?? 0) > silenceMs;
  });
  return hasLiveSession && silent.length > 0
    ? check(
        "WARN",
        name,
        `${rendered} — a session is live and ${silent.join(", ")} ${silent.length === 1 ? "has" : "have"} not fired in ${String(DOCTOR_HOOK_SILENT_WARN_MINUTES)} min: the agent may predate the wiring, the launcher may no longer resolve, or CROSSCHECK_DISABLED may be set in its environment`,
      )
    : check("PASS", name, rendered);
};

const checkHooksFiring = async (
  home: string,
  key: string,
  now: Date,
  live: LiveRepoSessions,
): Promise<Check> =>
  hooksFiringCheck({
    firedAt: await readHooksFired(home, key),
    liveSessionAgeMs: live.oldestAgeMs,
    nowMs: now.getTime(),
  });

/**
 * PURE, like its sibling. The WARN here is EXPECTED on a healthy headless
 * machine, which is why it leads with the explanation instead of a fix: every
 * session of the trial ran `--output-format stream-json` under the VS Code
 * extension, where Claude Code renders no statusline at all, and the developer
 * reading this needs to know where presence DOES reach them.
 */
export const statuslineRenderedCheck = (
  lastRenderedAt: string | null,
  hasLiveSession: boolean,
  nowMs: number,
): Check => {
  const name = "statusline last rendered";
  const headless =
    "headless and VS Code-extension sessions have no statusline; presence reaches you through the SessionStart briefing instead";
  const ms = lastRenderedAt === null ? Number.NaN : Date.parse(lastRenderedAt);
  if (Number.isNaN(ms)) {
    return hasLiveSession
      ? check("WARN", name, `never — ${headless}`)
      : check("PASS", name, "never");
  }
  const ageMs = nowMs - ms;
  return hasLiveSession &&
    ageMs > DOCTOR_STATUSLINE_SILENT_WARN_MINUTES * MS_PER_MINUTE
    ? check("WARN", name, `${formatAge(ageMs)} ago — ${headless}`)
    : check("PASS", name, `${formatAge(ageMs)} ago`);
};

const checkStatuslineRendered = async (
  home: string,
  key: string,
  now: Date,
  live: LiveRepoSessions,
): Promise<Check> =>
  statuslineRenderedCheck(
    await readStatuslineRendered(home, key),
    live.oldestAgeMs !== null,
    now.getTime(),
  );

/**
 * Session-state files whose session stopped saying anything.
 *
 * The SECOND number on the `unclosed sessions` line (trial finding M2). That
 * line counted `.pending-end` markers that aged out — a real fact, and a
 * narrow one: on the trial machine it read "none" while 75 of 100 state files
 * had not heartbeated in over an hour, each one pinning its spool file against
 * reap (`spool/reap.ts isSessionLive`). Two numbers, not one merged number:
 * an expired end and a zombie state file have different causes and different
 * consequences.
 */
const countStaleSessionStates = async (
  home: string,
  now: Date,
): Promise<{ readonly stale: number; readonly total: number }> => {
  const listing = await listSessionStateFiles(home, SESSION_STATE_SCAN_MAX_FILES);
  const maxAgeMs = DOCTOR_ZOMBIE_STATE_WARN_HOURS * MS_PER_HOUR;
  const ages = await Promise.all(
    listing.files.map(async (file) => {
      const parsed = SessionStateSchema.safeParse(
        await readJsonOrNull(file.path),
      );
      if (!parsed.success) {
        return false;
      }
      const ageMs = heartbeatAgeMs(parsed.data, now.getTime());
      return ageMs !== null && ageMs > maxAgeMs;
    }),
  );
  return {
    stale: ages.filter(Boolean).length,
    total: listing.filesSeen,
  };
};

/**
 * Whether `.crosscheck.json` will reach a teammate (Anhang A, A4-07).
 *
 * `runDoctor` reads the file only as a boolean — `isConnectedHere`, which
 * decides whether the parent-workspace scan runs — and never says a word about
 * it. That matters because the file is the ONLY thing that makes a repo
 * reportable (DESIGN.md §2.1): a checkout that lacks it is silent for
 * everybody who works in it, and one that has it UNTRACKED is silent for
 * everybody except the person who ran `init`. On a fresh clone of a repo whose
 * main branch carries the file, both states are fine — which is why this is a
 * LOW finding — but a branch that predates the commit shows `??` and nothing
 * on any surface explains why teammates see nothing there.
 *
 * PURE: the tracked verdict comes in as data, because `git ls-files` is the
 * caller's spawn to make.
 */
export const repoConnectedCheck = (
  present: boolean,
  tracked: boolean | null,
): Check => {
  const name = "repo connected";
  if (!present) {
    return check(
      "WARN",
      name,
      `no ${REPO_CONFIG_FILE} here — sessions starting in this repo report nothing; run crosscheck init`,
    );
  }
  if (tracked === false) {
    // PASS, not WARN, and the difference is what a reader can act on RIGHT
    // NOW. `crosscheck init` writes this file and cannot commit it, so every
    // correct install is untracked for the minutes before the commit — a WARN
    // there greets every new developer with a defect they have not caused.
    // The sentence still says the thing that matters. ABSENT stays a WARN,
    // which is the state the finding is actually about: a branch that predates
    // the commit, where every session in the repo is silent and nothing else
    // says why.
    return check(
      "PASS",
      name,
      `${REPO_CONFIG_FILE} present but untracked — commit it, or teammates' sessions stay silent in this repo`,
    );
  }
  return tracked === null
    ? check(
        "PASS",
        name,
        `${REPO_CONFIG_FILE} present (git could not say whether it is tracked)`,
      )
    : check("PASS", name, `${REPO_CONFIG_FILE} present and tracked`);
};

/**
 * `git ls-files --error-unmatch` exits non-zero for an untracked path, which
 * `runBoundedCommand` reports as null — the same null a missing git gives. So
 * the tracked answer is taken from the STDOUT of the plain listing instead:
 * the path echoed back means tracked, silence means either untracked or no
 * git, and the second `rev-parse` tells those apart (the check-ignore shape).
 */
const isRepoConfigTracked = async (
  repoRoot: string,
): Promise<boolean | null> => {
  const listed = await runBoundedCommand(
    ["git", "ls-files", "--", REPO_CONFIG_FILE],
    repoRoot,
    GIT_TIMEOUT_MS,
  );
  if (listed !== null) {
    return true;
  }
  const inWorkTree = await runBoundedCommand(
    ["git", "rev-parse", "--is-inside-work-tree"],
    repoRoot,
    GIT_TIMEOUT_MS,
  );
  return inWorkTree === "true" ? false : null;
};

const checkRepoConnected = async (
  repoRoot: string,
  present: boolean,
): Promise<Check> =>
  repoConnectedCheck(
    present,
    present ? await isRepoConfigTracked(repoRoot) : null,
  );

/**
 * ── Capture health, as a number (trial finding M1) ─────────────────────────
 *
 * `status` printed the spool depth and the cross-repo drop count; nothing
 * anywhere printed how many TARGETS a session had captured. So the H1
 * cross-worktree drop — a session whose every edit landed outside the repo it
 * was bound to, capturing nothing at all — produced `spool: 0 pending, 0
 * dropped`, 24 PASS lines and not one sentence about the thing that had
 * stopped working.
 *
 * WHERE THE COUNTERS COME FROM. The write side is the sibling capture branch,
 * which books `editToolFires` into session state. This reads them through a
 * LOCAL loose view with defaults rather than through `SessionStateSchema`, for
 * two reasons: `SessionStateSchema` is a `looseObject`, so the fields survive
 * a parse it does not know about, and a doctor that hard-required them could
 * not ship before the branch that writes them. When no state file carries the
 * counter at all, the line says "not measured" at PASS instead of printing a
 * fabricated zero.
 *
 * NO AGE IN THE LINE. Nothing timestamps an individual target, so "last 4m
 * ago" would have to be inferred from a state file's mtime — which moves for
 * a heartbeat as readily as for a capture. A number that is true beats a
 * freshness claim that is nearly true.
 */
const SessionCountersSchema = z.looseObject({
  hubUrl: z.string().default(""),
  repoId: z.string().default(""),
  // Read for the LIVENESS half, which is why the defaults are the unreadable
  // values: a file that carries neither timestamp cannot be dated, and an
  // undatable file is not evidence of a running session (heartbeatAgeMs).
  startedAt: z.string().default(""),
  lastHeartbeatAt: z.string().nullable().default(null),
  seenTargets: z.array(z.string()).default([]),
  editToolFires: z.number().int().min(0).optional(),
});

type SessionCounters = z.infer<typeof SessionCountersSchema>;

export interface LiveRepoSessions {
  /** State files of THIS repo whose session is still reporting, newest first. */
  readonly sessions: readonly SessionCounters[];
  /**
   * How long the OLDEST of them has been running, or null when none is live.
   *
   * The oldest, not the newest: a never-fired hook is evidence once SOME
   * session has been running long enough to have produced it, and taking the
   * youngest would let one fresh session mask a machine whose hooks stopped
   * hours ago. Null is the "no live session here" signal every gate reads.
   */
  readonly oldestAgeMs: number | null;
}

const EMPTY_LIVE_SESSIONS: LiveRepoSessions = {
  sessions: [],
  oldestAgeMs: null,
};

/**
 * The session-state scan, done ONCE, for every line that needs to know
 * whether anybody is running anything here.
 *
 * `hasLiveSessionState` used to answer this with `readdir(<home>/sessions)
 * .length > 0` — no age test and no repo test — and it gated four separate
 * WARNs. A state file is only deleted at SessionEnd and the connector-side
 * reap only clears files past MAX_SPOOL_AGE_DAYS = 7, so on the trial machine
 * 75 of 100 files were corpses and all four gates were permanently satisfied
 * by dead sessions: one line printed "1 of 1 session state file stale >1h"
 * while three others said "a session is live" and "the session is running"
 * (review finding B2-04/B2-L2).
 *
 * THE PREDICATE IS THE ONE THE REST OF THE FILE ALREADY USES —
 * `heartbeatAgeMs` inside DOCTOR_ZOMBIE_STATE_WARN_HOURS, the same one
 * `countStaleSessionStates` and the summarizer cost line read — so "stale" and
 * "live" can no longer contradict each other in the same run. And it is scoped
 * to this repo's hubUrl/repoId, because a teammate's session in another
 * checkout is not evidence about THIS repo's hooks.
 *
 * ONE PARSE PASS, keeping each state beside its file. The earlier capture
 * check built its repo filter and its liveness mask as two separate arrays and
 * then indexed one by the other's positions, so element i of the filtered list
 * was tested against the i-th newest file on the machine — a different session
 * (review finding B2-02).
 */
const readLiveRepoSessions = async (
  home: string,
  hubUrl: string,
  repoId: string,
  now: Date,
): Promise<LiveRepoSessions> => {
  const listing = await listSessionStateFiles(home, SESSION_STATE_SCAN_MAX_FILES);
  if (listing.files.length === 0) {
    return EMPTY_LIVE_SESSIONS;
  }
  const nowMs = now.getTime();
  const maxAgeMs = DOCTOR_ZOMBIE_STATE_WARN_HOURS * MS_PER_HOUR;
  const parsed = await Promise.all(
    listing.files.map(async (file) =>
      SessionCountersSchema.safeParse(await readJsonOrNull(file.path)),
    ),
  );
  const sessions = parsed
    .filter((entry) => entry.success)
    .map((entry) => entry.data)
    .filter((state) => state.hubUrl === hubUrl && state.repoId === repoId)
    .filter((state) => {
      const ageMs = heartbeatAgeMs(state, nowMs);
      return ageMs !== null && ageMs <= maxAgeMs;
    });
  const startedAges = sessions
    .map((state) => nowMs - Date.parse(state.startedAt))
    .filter((ageMs) => !Number.isNaN(ageMs));
  return {
    sessions,
    oldestAgeMs: startedAges.length === 0 ? null : Math.max(...startedAges),
  };
};

export interface CaptureFacts {
  /** True when at least one state file carried the counter at all. */
  readonly measured: boolean;
  readonly fires: number;
  readonly targets: number;
  readonly sessions: number;
}

/** PURE: the wording, pinned without a session on disk. */
export const captureCheck = (facts: CaptureFacts): Check => {
  const name = "capture";
  if (!facts.measured) {
    return check(
      "PASS",
      name,
      "not measured (edit-tool counters arrive with the capture fix)",
    );
  }
  const summary = `${String(facts.fires)} edit-tool fires -> ${String(facts.targets)} targets across ${String(facts.sessions)} live session${facts.sessions === 1 ? "" : "s"}`;
  return facts.fires > 0 && facts.targets === 0
    ? check(
        "WARN",
        name,
        `${summary} — every edit this session saw was discarded before it became a target: the usual cause is editing files in a DIFFERENT checkout or worktree than the session registered from`,
      )
    : check("PASS", name, summary);
};

/**
 * Stale sessions are excluded for the same reason the cost line excludes them:
 * a corpse's counters describe a session nobody is running.
 */
const checkCapture = (live: LiveRepoSessions): Check => {
  const counted = live.sessions;
  return captureCheck({
    measured: counted.some((state) => state.editToolFires !== undefined),
    fires: counted.reduce((total, state) => total + (state.editToolFires ?? 0), 0),
    targets: counted.reduce((total, state) => total + state.seenTargets.length, 0),
    sessions: counted.length,
  });
};

/**
 * What the hint-stats probe came back with.
 *
 * The two failure reasons are kept apart because they are different claims
 * about the world: "absent" (the hub answered 404) says this hub predates the
 * endpoint, and "unmeasured" (rejected key, unreachable, 5xx) says we never
 * got to ask. Collapsing them was the M3 defect in miniature — a line that
 * blames the hub for a local credential problem.
 */
export type HintsProbe =
  | { readonly ok: true; readonly stats: HintStats }
  | { readonly ok: false; readonly reason: "absent" | "unmeasured" };

/**
 * Whether hints CAN fire on this repo (trial finding M1/H3).
 *
 * `hint_deliveries` was write-only from the outside — `markHintsPulled` was
 * its only reader — so "are hints reaching anybody" had no answer anywhere.
 * And the number that decides it is not `delivered`: the selector only ever
 * proposes CLAIMS, so a repo with none delivers nothing however good the
 * ranking is. `delivered: 0` alone reads like a tuning problem; `claims: 0`
 * names the structural fact.
 *
 * An older hub 404s the endpoint, which is a PASS saying so — never a WARN,
 * because nothing about this install is wrong in that case (§R6). A hub that
 * rejected the key gets the file's usual "not measured" instead: `hub
 * reachable` already FAILs two lines up and owns that verdict.
 */
export const hintsCheck = (
  probe: HintsProbe,
  hasLiveSession: boolean,
): Check => {
  const name = "hints";
  if (!probe.ok) {
    return check(
      "PASS",
      name,
      probe.reason === "absent" ? "not available on this hub" : "not measured",
    );
  }
  const stats = probe.stats;
  const counts = `${String(stats.delivered)} delivered (${String(stats.pulled)} pulled), ${String(stats.claims)} claims on this repo`;
  // The live-session gate, same as `last capture sync` and `hooks firing`
  // above. A team that has not published anything YET is not broken — a fresh
  // `crosscheck login` would otherwise WARN on its very first doctor run, and
  // a warning that greets every new install is one nobody reads. With a
  // session running, zero claims is the answer to "why do I never get a hint".
  return hasLiveSession && stats.claims === 0
    ? check(
        "WARN",
        name,
        `${counts} — hints cannot fire: the selector only ever points at claims, and nothing has been published on this repo yet`,
      )
    : check("PASS", name, counts);
};

const checkHints = async (
  ctx: HubContext,
  repoId: string,
  live: LiveRepoSessions,
): Promise<Check> => {
  const result = await getHintStats(ctx, repoId);
  const probe: HintsProbe = result.ok
    ? { ok: true, stats: result.data }
    : {
        ok: false,
        reason:
          result.kind === "http" && result.status === HTTP_NOT_FOUND
            ? "absent"
            : "unmeasured",
      };
  return hintsCheck(probe, live.oldestAgeMs !== null);
};

/**
 * When a HOOK last reached the hub — trial finding H5, and the line's name
 * changed with its meaning.
 *
 * It used to read `lastOkAt`, which `recordSync` stamps after EVERY successful
 * request with a non-empty repo key — including the reachability probe six
 * lines up in `runDoctor`. The check was therefore reading what doctor had
 * just written: a machine whose hooks had not fired in three hours printed
 * `PASS last sync 0s ago`, and with a rejected key it printed `PASS last sync
 * 2h ago` directly under `FAIL hub reachable invalid api key`. The record is
 * now split (state/sync-state.ts): `lastOkAt` still means "the hub answered
 * this machine", and `lastCaptureOkAt` — written only by register, heartbeat,
 * records and end (http/hub.ts) — means "a hook got through". Reachability is
 * the `hub reachable` line's job; this line is the capture path's.
 *
 * The live-session gate stays: an age alone is not a defect (a developer who
 * has not started a session today is not broken), so the WARN needs a session
 * state file beside the stale stamp — the silent-death signature.
 */
const checkLastSync = async (
  home: string,
  key: string,
  now: Date,
  live: LiveRepoSessions,
): Promise<Check> => {
  const name = "last capture sync";
  const hasLiveSession = live.oldestAgeMs !== null;
  const sync = await readSyncState(home, key);
  if (sync.lastCaptureOkAt === null) {
    return hasLiveSession
      ? check(
          "WARN",
          name,
          "no hook has reached the hub yet, with a live session — the session is running and nothing it captured has landed",
        )
      : // A machine with no session on this repo yet: nothing has failed.
        check("PASS", name, "never — no session has reported from this repo");
  }
  const ageMs = now.getTime() - Date.parse(sync.lastCaptureOkAt);
  const isStale = ageMs > DOCTOR_LAST_SYNC_WARN_MINUTES * MS_PER_MINUTE;
  return isStale && hasLiveSession
    ? check("WARN", name, `${formatAge(ageMs)} ago with a live session`)
    : check("PASS", name, `${formatAge(ageMs)} ago`);
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
  // "Connected" in the committed sense (DESIGN.md §2.1): the repo root
  // carries .crosscheck.json. Only when the cwd is NOT that does the
  // workspace-root scan run — the parent-folder trap it exists to name.
  const isConnectedHere =
    identity !== null && (await readRepoConfig(identity.root)) !== null;
  const workspaceChecks = isConnectedHere ? [] : await workspaceRootChecks(cwd);
  // The user-level install state (finding #11), in BOTH branches: the Ken
  // shape — a parent-workspace cwd with neither project hooks nor a global
  // install — lands in the early branch, and leaving the check out of it
  // would silence the one place it exists for.
  const globalWiring = await readGlobalWiring(env);
  if (config === null || identity === null) {
    // The MCP checks belong in THIS branch too, and leaving them out was the
    // first version's bug: a developer with no key would have been told the hub
    // was unconfigured and nothing at all about the tools, which is the exact
    // silence rule 6 exists against.
    return summarize([
      configCheck,
      identityCheck,
      ...workspaceChecks,
      ...globalInstallChecks(
        globalWiring,
        identity === null
          ? null
          : await readProjectWiring(
              join(identity.root, CLAUDE_SETTINGS_DIR, CLAUDE_SETTINGS_FILE),
            ),
      ),
      check("FAIL", "hub reachable", "no hub configured"),
      ...(identity === null
        ? []
        : [
            await checkMcpRegistration(
              identity.root,
              globalWiring.mcpRegistered,
              await isPathIgnored(identity.root, MCP_CONFIG_FILE),
            ),
          ]),
      mcpUsableCheck({
        configured: config !== null,
        hubUrl: config?.hubUrl ?? null,
        // No probe ran in this branch: there is no hub to ask, so the line
        // rests on `configured` alone exactly as it always did here.
        hub: null,
        registered:
          globalWiring.mcpRegistered ||
          (identity !== null &&
            (await readRegisteredMcpEntry(identity.root, env)) !== null),
        probe: { kind: "not-probed", why: "no hub configured" },
      }),
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
  // repoKey "" keeps the probe out of the sync record, exactly like
  // `defaultMeasureLatency` above and `login`'s probe: with the real key it
  // stamped `lastSyncAt`/`lastOkAt` moments before `checkLastSync` read them,
  // which is half of what made `last sync` a tautology (H5).
  const probe = await hubRequest(
    { ...hubCtx, repoKey: "" },
    {
      method: "GET",
      path: `/api/presence?repo=${encodeURIComponent(PROBE_REPO)}`,
      schema: z.unknown(),
    },
  );
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
  const settingsInspection = await checkSettings(identity.root, globalWiring);
  // The launcher the hooks would actually run: the project scope's where it
  // is wired, else the user scope's — the spelling check must execute
  // whichever scope satisfies the hooks requirement (finding #13).
  const launcherCommand =
    settingsInspection.launcherCommand ?? globalWiring.launcherCommand;
  // Every settings file that could carry THIS repo's hooks: the project one
  // when the project scope is wired, the user one when it is, both under
  // double wiring (H6). When neither is wired the project path is still
  // offered, so a half-written install keeps today's reading rather than
  // going quiet.
  // Fetched once, before the summarize array, so the spool section can read
  // it: an older hub 404s and the count degrades to null (§R6).
  const openSessions = await getOpenSessions(hubCtx);
  const openOnHub = openSessions.ok ? openSessions.data.length : null;
  // The session-state scan, once, for every line that gates on "is anybody
  // running anything here" — four of them used to answer it with a bare
  // readdir and were all satisfied by week-old corpses (review finding B2-04).
  const liveSessions = await readLiveRepoSessions(
    config.home,
    config.hubUrl,
    identity.repoId,
    now,
  );
  // Whether the two PROJECT files this repo's advice keeps recommending can
  // actually reach a teammate (trial finding M11). Resolved once, passed as
  // data, so `globalInstallChecks` stays pure and testable.
  const ignoreVerdicts = {
    mcp: await isPathIgnored(identity.root, MCP_CONFIG_FILE),
    projectSettings: await isPathIgnored(
      identity.root,
      `${CLAUDE_SETTINGS_DIR}/${CLAUDE_SETTINGS_FILE}`,
    ),
  };
  const agentSettingsPaths = ((): readonly string[] => {
    const projectPath = join(
      identity.root,
      CLAUDE_SETTINGS_DIR,
      CLAUDE_SETTINGS_FILE,
    );
    const wired = [
      ...(settingsInspection.launcherCommand === null ? [] : [projectPath]),
      ...(globalWiring.hooksInstalled ? [globalWiring.settingsPath] : []),
    ];
    return wired.length > 0 ? wired : [projectPath];
  })();
  return summarize([
    configCheck,
    identityCheck,
    ...workspaceChecks,
    ...globalInstallChecks(
      globalWiring,
      settingsInspection.launcherCommand !== null,
      ignoreVerdicts.projectSettings,
    ),
    hubCheck,
    timeoutCheck(config.timeoutMs, owner),
    latencyCheck(measurement, config.timeoutMs, owner),
    ...settingsInspection.checks,
    ...(launcherCommand === null
      ? []
      : [await checkLauncher(launcherCommand, env)]),
    await checkAgentRestart(
      identity.root,
      agentSettingsPaths,
      agentProbe ?? defaultAgentProbe(cwd),
      now.getTime(),
    ),
    await checkMcpRegistration(
      identity.root,
      globalWiring.mcpRegistered,
      ignoreVerdicts.mcp,
    ),
    await checkMcpUsable(identity.root, env, {
      configured: true,
      hubUrl: config.hubUrl,
      hub: probe.ok
        ? { ok: true, status: 200, kind: "http" }
        : { ok: false, status: probe.status, kind: probe.kind },
      registered:
        globalWiring.mcpRegistered ||
        (await readRegisteredMcpEntry(identity.root, env)) !== null,
    }),
    ...(await checkSpool(config.home, key, now, openOnHub)),
    ...(await foreignDropChecks(config.home)),
    await checkSummarizerCost(config.home, config.hubUrl, identity.repoId),
    await checkSummarizerRunner(env, config.home),
    await checkLastSync(config.home, key, now, liveSessions),
    await checkAbsences(hubCtx, identity.repoId),
    await checkPrivacy(hubCtx),
    skewCheck,
    bunfigCheck,
    ...(await checkCursor(identity.root, env, config.home, key)),
    // Appended at the END so a sibling branch's rebase stays mechanical, and
    // because these read execution rather than configuration: the reader has
    // just been told what is WIRED, and these say what has actually RUN.
    await checkHooksFiring(config.home, key, now, liveSessions),
    await checkStatuslineRendered(config.home, key, now, liveSessions),
    await checkRepoConnected(identity.root, isConnectedHere),
    checkCapture(liveSessions),
    await checkHints(hubCtx, identity.repoId, liveSessions),
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
