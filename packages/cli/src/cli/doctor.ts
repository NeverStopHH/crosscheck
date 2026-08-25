import { readdir, readlink, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import { z } from "zod";

import {
  CLAUDE_SETTINGS_DIR,
  CLAUDE_SETTINGS_FILE,
  DOCTOR_AGENT_CWD_TIMEOUT_MS,
  DOCTOR_CAPTURE_MAX_SESSION_LINES,
  DOCTOR_PATH_MAX_CHARS,
  DOCTOR_TOOL_NAME_MAX_CHARS,
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
  STATUS_MAX_SESSION_STATES,
  SUMMARIZER_CLAUDE_MIN_VERSION,
  TRIPWIRE_MODE_ENV,
  TRIPWIRE_MODE_NOTICE,
} from "@crosscheck/connector-core/constants.ts";
import { resolveTripwireMode } from "@crosscheck/connector-core/config/tripwire.ts";
import {
  isCaptureSilentlyDead,
  readCaptureHealth,
} from "@crosscheck/connector-core/state/capture-health.ts";
import type {
  CaptureHealth,
  SessionCaptureHealth,
} from "@crosscheck/connector-core/state/capture-health.ts";
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
import { hasGitEntry } from "@crosscheck/connector-core/config/connected-repo.ts";
import { readRepoConfig } from "@crosscheck/connector-core/config/repo-config.ts";
import {
  formatForeignDropLine,
  readForeignRepoDrops,
} from "@crosscheck/connector-core/state/foreign-drops.ts";
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
import {
  getAbsences,
  getHintStats,
  getPrivacySettings,
  getWorkContexts,
} from "@crosscheck/connector-core/http/hub.ts";
import { readDropSummary, readUnrecordedDrop } from "@crosscheck/connector-core/spool/drops.ts";
import { oldestSpoolLineMs, spoolDepth } from "@crosscheck/connector-core/spool/files.ts";
import { readLockHolder } from "@crosscheck/connector-core/spool/lock.ts";
import { readUnclosedSummary } from "@crosscheck/connector-core/spool/unclosed.ts";
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
import { isOwnedCommand } from "@crosscheck/connector-claude";
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

/** Hook events a healthy install registers — project and user scope alike. */
const REQUIRED_HOOK_EVENTS = [
  "SessionStart",
  "PostToolUse",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "Stop",
] as const;

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
const checkMcpRegistration = async (
  repoRoot: string,
  userScopeRegistered: boolean,
): Promise<Check> => {
  const path = join(repoRoot, MCP_CONFIG_FILE);
  const raw = await readTextOrNull(path);
  if (raw === null) {
    // Finding #13: a missing PROJECT file is not a broken install when the
    // user scope registers the tools — but user scope covers only THIS
    // machine, so the committed-file advice survives as a note instead of
    // being lost with the FAIL.
    if (userScopeRegistered) {
      return check(
        "PASS",
        "mcp tools registered",
        `via global install (user scope, this machine only) — teammates get the tools from a committed ${path}: run crosscheck init, then commit the file`,
      );
    }
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

const HTTP_NOT_FOUND = 404;

const plural = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? "" : "s"}`;

const ageOf = (iso: string, now: Date): string => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "unknown age" : `${formatAge(now.getTime() - ms)} ago`;
};

/**
 * A local fact of the developer's own (a path, a host tool name) on the
 * doctor line: control characters stripped, length capped — keeping the TAIL
 * of a path, which is the part that tells worktrees apart.
 */
const boundedLocal = (value: string, max: number): string => {
  const clean = value.replace(/[\p{Cc}\p{Cf}]/gu, "");
  return clean.length <= max ? clean : `…${clean.slice(clean.length - (max - 1))}`;
};

/**
 * The #18 diagnosis line, one per open session: fires → targets, the root the
 * session is bound to, how long since it last spoke, the last edit-tool name,
 * and whether the last edited path resolved (against which root) or dropped —
 * NAMING the path in the drop branch, because "something did not resolve" is
 * not a cause a remote reader can act on, and the path is the one fact that
 * tells a worktree, a second repo and a loose file apart.
 *
 * The heartbeat age is what separates an open session from a running one: a
 * state file survives until SessionEnd deletes it, and the trial found most
 * sessions never end (104 of 127).
 */
const captureSessionLine = (session: SessionCaptureHealth, now: Date): string => {
  const last = session.lastTargetAt === null ? "" : ` (last ${ageOf(session.lastTargetAt, now)})`;
  const heard = session.lastHeartbeatAt ?? session.startedAt;
  const heartbeat = `${ageOf(heard, now)}${session.isIdle ? ", idle" : ""}`;
  const tool =
    session.lastPostToolUseTool === null
      ? "none yet"
      : boundedLocal(session.lastPostToolUseTool, DOCTOR_TOOL_NAME_MAX_CHARS);
  const resolved =
    session.lastEditedPath === null
      ? "no edit yet"
      : session.lastEditedPathResolvedAgainst === null
        ? `no — ${boundedLocal(session.lastEditedPath, DOCTOR_PATH_MAX_CHARS)} (${plural(session.foreignRepoDrops, "foreign-repo")}, ${plural(session.outsideRootDrops, "outside-root drop")})`
        : `yes (against ${boundedLocal(session.lastEditedPathResolvedAgainst, DOCTOR_PATH_MAX_CHARS)})`;
  return (
    `${session.hostSessionKey.slice(0, 8)}: ${plural(session.editToolFires, "edit-tool fire")} → ` +
    `${plural(session.targetsCapturedCount, "target")}${last} · repoRoot ${boundedLocal(session.repoRoot, DOCTOR_PATH_MAX_CHARS)} · ` +
    `heartbeat ${heartbeat} · last tool ${tool} · last edited path resolved: ${resolved}`
  );
};

/**
 * Capture health (trial findings #17/#18/#20): per open session of this repo,
 * "N edit-tool fires → M targets" with the diagnosis facts, WARN when N
 * reaches DOCTOR_CAPTURE_SILENT_FIRES_WARN and M is 0 — the worktree silence
 * (371 edits → 0 targets) and Ken's "0 targets" shape, made a line. ALWAYS
 * printed: a repo with no open session says so (PASS), never nothing.
 *
 * A read that was CUT gets its own line first. Without it a truncated scan and
 * a dead capture print the same thing, which is the failure this check exists
 * to end.
 */
const captureChecks = (health: CaptureHealth, now: Date): readonly Check[] => {
  const cut =
    health.statesRead >= health.statesTotal
      ? []
      : [
          check(
            "WARN",
            "capture",
            `read the ${String(health.statesRead)} most recently written of ${String(health.statesTotal)} session state files (cap ${String(STATUS_MAX_SESSION_STATES)}) — every count below is of those; older sessions of this repo are not in them. State files are deleted at SessionEnd, so a large number of them means sessions that never ended`,
          ),
        ];
  if (health.sessions.length === 0) {
    return [
      ...cut,
      check(
        "PASS",
        "capture",
        "no open session of this repo on this machine (counts are per session and clear at SessionEnd)",
      ),
    ];
  }
  const shown = health.sessions.slice(0, DOCTOR_CAPTURE_MAX_SESSION_LINES);
  const lines = shown.map((session) => {
    const line = captureSessionLine(session, now);
    return isCaptureSilentlyDead(session)
      ? check(
          "WARN",
          "capture",
          `${line} — edits fire but nothing is captured: the edited paths never resolved against a root of this repo (a worktree of a different repo, files outside every checkout) or were all denylisted; the next edit updates this line`,
        )
      : check("PASS", "capture", line);
  });
  const rest = health.sessions.length - shown.length;
  return rest === 0
    ? [...cut, ...lines]
    : [
        ...cut,
        ...lines,
        check(
          "PASS",
          "capture",
          `… and ${plural(rest, "more open session")} (first ${String(DOCTOR_CAPTURE_MAX_SESSION_LINES)} shown)`,
        ),
      ];
};

/**
 * Hint health (#19/#20): WARN when the hub holds 0 claims for this repo AND
 * no targets-only pointer was possible (0 targets, or no prompt of a live
 * session here ever matched one) — saying what WOULD make a hint possible,
 * since 3 trial days of silence had no line to explain them. The hub's own
 * delivered/pulled window is appended when it answers; an older hub without
 * /api/hints/stats is named as such (it predates targets-only pointers too).
 */
const checkHints = async (
  ctx: HubContext,
  repoId: string,
  health: CaptureHealth,
): Promise<Check> => {
  const contexts = await getWorkContexts(ctx, repoId);
  if (!contexts.ok) {
    return check("PASS", "hints", "not measured (hub unreachable)");
  }
  const stats = await getHintStats(ctx, repoId);
  const claims = contexts.data.reduce((sum, row) => sum + (row.claimCount ?? 0), 0);
  const targetsKnown = contexts.data.every((row) => typeof row.targetCount === "number");
  const targets = contexts.data.reduce((sum, row) => sum + (row.targetCount ?? 0), 0);
  const targetsPart = targetsKnown ? plural(targets, "target") : "targets unknown (older hub)";
  const local = `live sessions here: ${plural(health.hintsDelivered, "hint")} delivered, ${plural(health.hintCandidatesSeen, "candidate")} seen`;
  const hubPart = stats.ok
    ? `hub ${String(stats.data.windowDays)}d: ${String(stats.data.delivered)} delivered, ${String(stats.data.pulled)} pulled`
    : stats.status === HTTP_NOT_FOUND
      ? "hub predates /api/hints/stats (upgrade it for targets-only pointers and these counts)"
      : "hub stats not measured";
  const nothingToMatch = !targetsKnown || targets === 0 || health.hintCandidatesSeen === 0;
  if (claims === 0 && nothingToMatch) {
    const why =
      targetsKnown && targets > 0
        ? `no prompt of a live session here matched one of its ${plural(targets, "target")}`
        : targetsPart;
    return check(
      "WARN",
      "hints",
      `hints cannot fire yet: the hub holds 0 claims for this repo and ${why} — a teammate's claim, or a prompt naming a file a teammate's context touched, would make one possible; ${local}; ${hubPart}`,
    );
  }
  return check(
    "PASS",
    "hints",
    `hub holds ${plural(claims, "claim")}, ${targetsPart} for this repo; ${local}; ${hubPart}`,
  );
};

/**
 * The Q2 knob, visible (trial finding #25): which PreToolUse decision the
 * hooks on this machine emit. Both are deliberate choices — PASS either way —
 * but a headless orchestration session under the default gets a one-shot
 * deny with the reason, and this is where that is named.
 */
const tripwireModeCheck = (env: Env): Check => {
  const mode = resolveTripwireMode(env);
  return mode === TRIPWIRE_MODE_NOTICE
    ? check(
        "PASS",
        "tripwire mode",
        `${mode} (${TRIPWIRE_MODE_ENV}=${mode}: the model is briefed via additionalContext only, the edit is never asked or denied)`,
      )
    : check(
        "PASS",
        "tripwire mode",
        `${mode} (default, DESIGN §4; a headless claude -p session cannot prompt, so Claude Code turns the ask into a one-shot deny carrying the reason — export ${TRIPWIRE_MODE_ENV}=${TRIPWIRE_MODE_NOTICE} for orchestration/CI sessions)`,
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
            ),
          ]),
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
  const settingsInspection = await checkSettings(identity.root, globalWiring);
  // The launcher the hooks would actually run: the project scope's where it
  // is wired, else the user scope's — the spelling check must execute
  // whichever scope satisfies the hooks requirement (finding #13).
  const launcherCommand =
    settingsInspection.launcherCommand ?? globalWiring.launcherCommand;
  // Capture + hint counters of this repo's live sessions (#17/#18/#20), read
  // once and shared by the capture and hints checks below.
  const captureHealth = await readCaptureHealth(
    config.home,
    config.hubUrl,
    identity.repoId,
  );
  return summarize([
    configCheck,
    identityCheck,
    ...workspaceChecks,
    ...globalInstallChecks(
      globalWiring,
      settingsInspection.launcherCommand !== null,
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
      join(identity.root, CLAUDE_SETTINGS_DIR, CLAUDE_SETTINGS_FILE),
      agentProbe ?? defaultAgentProbe(cwd),
      now.getTime(),
    ),
    await checkMcpRegistration(identity.root, globalWiring.mcpRegistered),
    mcpUsableCheck(true, config.hubUrl),
    ...(await checkSpool(config.home, key, now)),
    ...(await foreignDropChecks(config.home)),
    ...captureChecks(captureHealth, now),
    await checkHints(hubCtx, identity.repoId, captureHealth),
    tripwireModeCheck(env),
    await checkSummarizerCost(config.home, config.hubUrl, identity.repoId),
    await checkSummarizerRunner(env, config.home),
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
