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

export interface GlobalWiring {
  readonly settingsPath: string;
  /** True = owned hook commands present in the user settings. */
  readonly hooksInstalled: boolean;
  /** True = the user settings file exists but is not parseable JSON. */
  readonly unreadable: boolean;
  /** True = the user-scope mcpServers carries our entry (~/.claude.json). */
  readonly mcpRegistered: boolean;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const hasOwnedHook = (settings: Record<string, unknown>): boolean =>
  Object.values(asRecord(settings["hooks"])).some(
    (groups) =>
      Array.isArray(groups) &&
      groups.some((group) =>
        (Array.isArray(asRecord(group)["hooks"])
          ? (asRecord(group)["hooks"] as readonly unknown[])
          : []
        ).some((hook) => isOwnedCommand(asRecord(hook)["command"])),
      ),
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
    return hasOwnedHook(asRecord(JSON.parse(raw) as unknown));
  } catch {
    return false;
  }
};

/** The user-scope install state, resolved read-only and fail-open. */
export const readGlobalWiring = async (env: Env): Promise<GlobalWiring> => {
  const settingsPath = claudeUserSettingsPath(env);
  const raw = await readTextOrNull(settingsPath);
  let hooksInstalled = false;
  let unreadable = false;
  if (raw !== null) {
    try {
      hooksInstalled = hasOwnedHook(asRecord(JSON.parse(raw) as unknown));
    } catch {
      unreadable = true;
    }
  }
  let mcpRegistered = false;
  const mcpRaw = await readTextOrNull(claudeUserMcpPath(env));
  if (mcpRaw !== null) {
    try {
      const servers = asRecord(
        asRecord(JSON.parse(mcpRaw) as unknown)["mcpServers"],
      );
      mcpRegistered = isOwnedMcpEntry(servers[MCP_SERVER_KEY]);
    } catch {
      // An unreadable ~/.claude.json is Claude's problem to report, not a
      // reason to fail doctor: the mcp line simply reads "absent".
    }
  }
  return { settingsPath, hooksInstalled, unreadable, mcpRegistered };
};

const check = (level: Check["level"], name: string, detail: string): Check => ({
  level,
  name,
  detail,
});

/**
 * The doctor lines. `projectWired` is whether crosscheck hooks are
 * registered project-scoped where doctor runs (null = there is no repo
 * here at all — the parent-workspace shape).
 */
export const globalInstallChecks = (
  wiring: GlobalWiring,
  projectWired: boolean | null,
): readonly Check[] => {
  const name = "global install";
  if (wiring.unreadable) {
    return [
      check(
        "WARN",
        name,
        `${wiring.settingsPath} is not valid json — the user-level state cannot be read`,
      ),
    ];
  }
  if (wiring.hooksInstalled && projectWired === true) {
    return [
      check(
        "WARN",
        name,
        `double wiring: this repo registers project hooks AND ${wiring.settingsPath} registers user-level ones — identical commands run once (Claude Code dedups them), differing spellings run twice with capture kept exactly-once; remove one side: \`crosscheck init --global --remove\`, or strip the repo's .claude/settings.json entries`,
      ),
    ];
  }
  if (wiring.hooksInstalled) {
    return [
      check(
        "PASS",
        name,
        `${wiring.settingsPath} (covers every checkout, worktree and parent workspace on this machine${wiring.mcpRegistered ? ", mcp tools at user scope" : "; user-scope mcp tools missing — rerun crosscheck init --global"})`,
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
