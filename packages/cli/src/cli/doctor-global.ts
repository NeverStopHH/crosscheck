/**
 * Doctor's user-level install checks (finding #11) — the three states a
 * machine-wide wiring can be in, each with the sentence that names it:
 *
 *   - THE KEN SHAPE: no project hooks where the session starts AND no
 *     global install — the session is deaf, and before `init --global`
 *     existed the only cure was hand-copying settings files around. The
 *     WARN names the command that fixes it for every checkout, worktree
 *     and parent workspace at once.
 *   - DOUBLE WIRING: project hooks AND a global install. Claude Code runs
 *     an identical handler defined in both files once, a differing
 *     spelling runs twice — capture stays exactly-once either way
 *     (session-state seen-set + hub idempotency,
 *     connector-claude/test/double-wiring.test.ts) — but the redundancy is
 *     worth a sentence and the cleanup command.
 *   - GLOBAL PRESENT alone: a PASS that says what it covers.
 *
 * Read-only, fail-open: an unreadable user settings file is reported as
 * such, never a crash.
 */
import {
  claudeUserMcpPath,
  claudeUserSettingsPath,
  isOwnedCommand,
} from "@crosscheck/connector-claude";
import { MCP_SERVER_KEY } from "@crosscheck/connector-core/constants.ts";
import { isOwnedMcpEntry } from "@crosscheck/connector-core/config/mcp-config.ts";
import { readTextOrNull } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import type { Check } from "./doctor.ts";
import { readJsonConfig, unreadableClause } from "./init-io.ts";
import type { ReadRefusal } from "./init-io.ts";
import { doubleWiringRemedy } from "./project-copy.ts";
import type { ProjectCopy } from "./project-copy.ts";

export interface GlobalWiring {
  readonly settingsPath: string;
  /** True = owned hook commands present in the user settings. */
  readonly hooksInstalled: boolean;
  /**
   * Why the user settings file EXISTS but could not be read — no permission,
   * not json, not an object; null = read, or absent. While it is set, every
   * "installed?" fact below is unknown, not false (review 2026-10-05).
   */
  readonly unreadable: ReadRefusal | null;
  readonly mcpPath: string;
  /** True = the user-scope mcpServers carries our entry (~/.claude.json). */
  readonly mcpRegistered: boolean;
  /** Why ~/.claude.json exists but could not be read; null = `mcpRegistered` is a fact. */
  readonly mcpUnreadable: ReadRefusal | null;
  /** Hook events carrying an owned command in the user settings. */
  readonly hookEvents: readonly string[];
  /** The first owned hook command — what a user-scope hook would run. */
  readonly launcherCommand: string | null;
  /** The user-scope statusLine command, whoever owns it (null = none). */
  readonly statuslineCommand: string | null;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export interface OwnedHookEntry {
  readonly event: string;
  readonly command: string;
}

/**
 * Every owned hook command in a Claude settings object, keyed by the event
 * it fires on — the one extraction both scopes' checks read (finding #13
 * made the project check and this file disagree about what "wired" means).
 */
export const ownedHookEntries = (
  settings: Record<string, unknown>,
): readonly OwnedHookEntry[] =>
  Object.entries(asRecord(settings["hooks"])).flatMap(([event, groups]) =>
    (Array.isArray(groups) ? groups : []).flatMap((group) => {
      const entries = asRecord(group)["hooks"];
      return (Array.isArray(entries) ? entries : [])
        .map((entry) => asRecord(entry)["command"])
        .filter(isOwnedCommand)
        .map((command) => ({ event, command: String(command) }));
    }),
  );

/**
 * Whether a PROJECT-scoped settings file registers crosscheck hooks — the
 * other half of the double-wiring question, read with the same fail-open
 * discipline. Used by doctor's early branch, where checkSettings does not
 * run (no usable config), and the Ken shape still has to be told apart
 * from a healthy project install.
 */
export const readProjectWiring = async (
  settingsPath: string,
): Promise<boolean> => {
  const raw = await readTextOrNull(settingsPath);
  if (raw === null) {
    return false;
  }
  try {
    return ownedHookEntries(asRecord(JSON.parse(raw) as unknown)).length > 0;
  } catch {
    return false;
  }
};

/**
 * The user-scope install state, read-only and fail-open — through
 * `readJsonConfig`, which tells an ABSENT file from one that exists and could
 * not be read. `readTextOrNull` folded the two, so an EACCES
 * ~/.claude/settings.json read as "no user-level install" (review 2026-10-05).
 */
export const readGlobalWiring = async (env: Env): Promise<GlobalWiring> => {
  const settingsPath = claudeUserSettingsPath(env);
  const mcpPath = claudeUserMcpPath(env);
  const settingsRead = await readJsonConfig(settingsPath);
  const settings = settingsRead.ok ? settingsRead.value : {};
  const hookEntries = ownedHookEntries(settings);
  const statusline = asRecord(settings["statusLine"])["command"];
  const mcpRead = await readJsonConfig(mcpPath);
  return {
    settingsPath,
    hooksInstalled: hookEntries.length > 0,
    unreadable: settingsRead.ok ? null : settingsRead.reason,
    mcpPath,
    mcpRegistered:
      mcpRead.ok && isOwnedMcpEntry(asRecord(mcpRead.value["mcpServers"])[MCP_SERVER_KEY]),
    mcpUnreadable: mcpRead.ok ? null : mcpRead.reason,
    hookEvents: hookEntries.map((entry) => entry.event),
    launcherCommand: hookEntries[0]?.command ?? null,
    statuslineCommand: typeof statusline === "string" ? statusline : null,
  };
};

/**
 * The sentence every surface prints for a user settings file that exists and
 * could not be read — never "no user-level install"; null = it was read.
 */
export const userLevelUnknown = (wiring: GlobalWiring): string | null =>
  wiring.unreadable === null
    ? null
    : `${unreadableClause(wiring.settingsPath, wiring.unreadable)} — whether a user-level install exists is unknown`;

/** The same for ~/.claude.json, worded for the mcp lines; null = it was read. */
export const userMcpUnknown = (wiring: GlobalWiring): string | null =>
  wiring.mcpUnreadable === null
    ? null
    : `${unreadableClause(wiring.mcpPath, wiring.mcpUnreadable)} — whether the tools are registered at user scope is unknown`;

const check = (level: Check["level"], name: string, detail: string): Check => ({
  level,
  name,
  detail,
});

/** The user-scope mcp tools, as the global-install PASS line words them. */
const userMcpClause = (wiring: GlobalWiring): string => {
  if (wiring.mcpRegistered) {
    return ", mcp tools at user scope";
  }
  const unknown = userMcpUnknown(wiring);
  return unknown === null
    ? "; user-scope mcp tools missing — rerun crosscheck init --global"
    : `; ${unknown}`;
};

/**
 * The doctor lines. `projectWired` is whether crosscheck hooks are
 * registered project-scoped where doctor runs (null = there is no repo
 * here at all — the parent-workspace shape).
 *
 * `projectCopy` is the project copy's facts (project-copy.ts) — whether its
 * settings are gitignored, whether `.cursor/` holds crosscheck's entries —
 * passed IN as data so this stays a pure function; `null` = not read (the
 * caller reads them only when both sides are wired).
 */
export const globalInstallChecks = (
  wiring: GlobalWiring,
  projectWired: boolean | null,
  projectCopy: ProjectCopy | null = null,
): readonly Check[] => {
  const name = "global install";
  const unknown = userLevelUnknown(wiring);
  if (unknown !== null) {
    return [check("WARN", name, unknown)];
  }
  if (wiring.hooksInstalled && projectWired === true) {
    // Worded from the project copy's facts (project-copy.ts says why each
    // matters), so init's note at install time says the same sentence.
    const remedy = doubleWiringRemedy(projectCopy);
    return [
      check(
        "WARN",
        name,
        `double wiring: this repo registers project hooks AND ${wiring.settingsPath} registers user-level ones — identical commands run once (Claude Code dedups them), differing spellings run twice with capture kept exactly-once; ${remedy}`,
      ),
    ];
  }
  if (wiring.hooksInstalled) {
    return [
      check(
        "PASS",
        name,
        `${wiring.settingsPath} (covers every checkout, worktree and parent workspace on this machine${userMcpClause(wiring)})`,
      ),
    ];
  }
  if (projectWired === true) {
    return [
      check(
        "PASS",
        name,
        "absent (project hooks cover this repo; `crosscheck init --global` would cover every checkout and worktree)",
      ),
    ];
  }
  // The Ken shape: nothing project-scoped here, nothing user-scoped —
  // sessions starting in this directory load no crosscheck hooks at all.
  return [
    check(
      "WARN",
      name,
      "no crosscheck hooks load for sessions starting here (no project settings, no user-level install) — run `crosscheck init --global` once per machine: it covers every checkout, worktree and parent workspace",
    ),
  ];
};
