/**
 * `crosscheck init --global` (finding #11): the user-level install.
 *
 * Project-scoped init wires ONE checkout, and every new checkout, worktree
 * or parent-workspace session starts deaf until somebody re-runs it — two
 * real incidents in one week (a Cursor workspace rooted at the repo's
 * parent, a fresh git worktree of an already-connected repo). This command
 * wires the machine ONCE, at the scope Claude Code reads for every
 * session:
 *
 *   - hooks + statusline into `~/.claude/settings.json` (user settings;
 *     hook entries MERGE across settings levels, and an identical handler
 *     in more than one settings file runs once —
 *     code.claude.com/docs/en/hooks);
 *   - the MCP server into `~/.claude.json` top-level `mcpServers` — the
 *     user scope `claude mcp add --scope user` writes; a project
 *     `.mcp.json` entry takes precedence with connect-once semantics
 *     (code.claude.com/docs/en/mcp);
 *   - with `--cursor`, the same pair into `~/.cursor/hooks.json` +
 *     `~/.cursor/mcp.json` (Cursor's documented user level; Cursor runs
 *     ALL matching hooks from every source — no cross-level dedup — and
 *     user-level hooks do not reach Cursor cloud agents:
 *     cursor.com/docs/agent/hooks).
 *
 * WHERE A SESSION REPORTS IS UNCHANGED (DESIGN.md §2.1, non-negotiable):
 * the wiring is machine-wide, the TRUST is per-repo — only a repo whose
 * root carries the committed `.crosscheck.json` ever reports, and every
 * other directory stays silent (`loadReportableConfig`,
 * connector-claude/test/global-wiring-silence.test.ts).
 *
 * `--remove` is the surgical inverse: it strips exactly the crosscheck
 * entries from all four user-scope files — install flags do not need to be
 * remembered — and leaves every foreign byte where it was.
 */
import { homedir } from "node:os";
import { join } from "node:path";

import {
  EXIT_ABORTED,
  EXIT_FAIL,
  EXIT_OK,
} from "@crosscheck/connector-core/constants.ts";
import { normalizeHubUrl, readStoredConfig } from "@crosscheck/connector-core/config/config.ts";
import { crosscheckHome } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import {
  mergeMcpConfig,
  removeMcpConfig,
} from "@crosscheck/connector-core/config/mcp-config.ts";
import type { McpServerEntry } from "@crosscheck/connector-core/config/mcp-config.ts";
import {
  resolveCommandPrefix,
  resolveMcpLauncher,
} from "@crosscheck/connector-core/config/launcher.ts";
import {
  buildSettingsPlan,
  claudeUserMcpPath,
  claudeUserSettingsPath,
  mergeClaudeSettings,
  removeClaudeSettings,
} from "@crosscheck/connector-claude";
import { resolveLauncher, RESTART_HINT_LINE } from "./init.ts";
import { readJsonConfig, renderJsonFile, writeIfChanged } from "./init-io.ts";
import type { ReadJson } from "./init-io.ts";
import type { CliResult } from "./login.ts";

export const INIT_GLOBAL_FLAG = "--global";
export const INIT_REMOVE_FLAG = "--remove";

/** Cursor's user-level configuration directory (cursor.com/docs/agent/hooks). */
const cursorUserDir = (env: Env): string =>
  join(env["HOME"] ?? homedir(), ".cursor");

export interface InitGlobalOptions {
  readonly commandPrefix?: string | undefined;
  readonly forceStatusline: boolean;
  readonly cursor: boolean;
  readonly remove: boolean;
}

/**
 * The wiring is inert without a login: hooks fail open when no credentials
 * resolve, so a global install before `crosscheck login` would be a machine
 * full of hooks that silently do nothing — the exact invisible state this
 * feature exists to kill. Same split blame as project init: the hub URL
 * and the key are missing for different reasons.
 */
const checkLogin = async (env: Env): Promise<string | null> => {
  const stored = await readStoredConfig(crosscheckHome(env));
  const candidate = env["CROSSCHECK_HUB_URL"] ?? stored?.hubUrl;
  if (candidate === undefined) {
    return "no hub url — run `crosscheck login <hubUrl>` first";
  }
  const hubUrl = normalizeHubUrl(candidate);
  if (hubUrl === null) {
    return `invalid hub url: ${candidate}`;
  }
  if ((env["CROSSCHECK_API_KEY"] ?? stored?.apiKey) === undefined) {
    return `no api key for ${hubUrl} — run \`crosscheck login ${hubUrl}\` first`;
  }
  return null;
};

const abortUnparseable = (path: string): CliResult => ({
  stdout: `${path} is not valid json — nothing was changed\n`,
  exitCode: EXIT_ABORTED,
});

const wroteLine = (path: string, wrote: boolean): string =>
  wrote ? `wrote ${path}` : `${path} unchanged (already installed)`;

export const runInitGlobal = async (
  options: InitGlobalOptions,
  env: Env,
): Promise<CliResult> => {
  if (options.remove) {
    return runGlobalRemove(env);
  }
  const loginError = await checkLogin(env);
  if (loginError !== null) {
    return { stdout: `${loginError}\n`, exitCode: EXIT_FAIL };
  }
  // Resolved BEFORE anything is read or written, like project init: a
  // refused launcher (npx/bunx cache) must leave the machine untouched.
  const launcher = await resolveLauncher(options.commandPrefix, env);
  if (launcher.kind === "refused") {
    return { stdout: `${launcher.reason}\n`, exitCode: EXIT_FAIL };
  }
  const prefix = resolveCommandPrefix(launcher);
  const mcpEntry = resolveMcpLauncher(launcher);

  const settingsPath = claudeUserSettingsPath(env);
  const mcpPath = claudeUserMcpPath(env);

  // ALL files are read and validated BEFORE any is written — a half-done
  // user-scope install (hooks registered, tools not) breaks every session
  // on the machine at once, not one repo's.
  const settingsRead = await readJsonConfig(settingsPath);
  if (!settingsRead.ok) {
    return abortUnparseable(settingsPath);
  }
  const mcpRead = await readJsonConfig(mcpPath);
  if (!mcpRead.ok) {
    return abortUnparseable(mcpPath);
  }
  const cursorReads = options.cursor ? await readCursorFiles(env) : null;
  if (cursorReads !== null && !cursorReads.ok) {
    return abortUnparseable(cursorReads.path);
  }

  const merged = mergeClaudeSettings(
    settingsRead.value,
    buildSettingsPlan(prefix, options.forceStatusline),
  );
  const settingsOutcome = await writeIfChanged(
    settingsPath,
    settingsRead.raw,
    renderJsonFile(merged.settings),
  );
  const mcpOutcome = await writeIfChanged(
    mcpPath,
    mcpRead.raw,
    renderJsonFile(mergeMcpConfig(mcpRead.value, mcpEntry)),
  );
  const cursorLines =
    cursorReads === null || !cursorReads.ok
      ? []
      : await applyCursorInstall(cursorReads, prefix, mcpEntry);

  const notes = [
    ...(merged.statuslineInstalled
      ? []
      : [
          "statusline not installed (existing statusline preserved) — rerun with --force-statusline to replace",
        ]),
    ...(launcher.kind === "entry"
      ? [
          "launcher is an absolute path on this machine — reinstalling crosscheck elsewhere means rerunning crosscheck init --global",
        ]
      : []),
    "mcp tools registered at user scope — a repo's committed .mcp.json takes precedence where both exist",
    // The §2.1 line, said at install time so nobody expects machine-wide
    // wiring to mean machine-wide reporting.
    "this wiring covers every checkout, worktree and parent workspace, but sessions report ONLY in repos with a committed .crosscheck.json — run `crosscheck init` inside a repo to connect it; everywhere else stays silent",
  ];
  return {
    stdout: [
      wroteLine(settingsOutcome.path, settingsOutcome.wrote),
      wroteLine(mcpOutcome.path, mcpOutcome.wrote),
      ...cursorLines,
      `hooks use launcher: ${prefix}`,
      ...notes,
      RESTART_HINT_LINE,
      "",
    ].join("\n"),
    exitCode: EXIT_OK,
  };
};

interface CursorReads {
  readonly ok: true;
  readonly hooksPath: string;
  readonly hooksRaw: string | null;
  readonly hooksValue: Record<string, unknown>;
  readonly mcpPath: string;
  readonly mcpRaw: string | null;
  readonly mcpValue: Record<string, unknown>;
}

type CursorReadResult =
  | CursorReads
  | { readonly ok: false; readonly path: string };

const readCursorFiles = async (env: Env): Promise<CursorReadResult> => {
  // DYNAMIC import like project init's cursor branch: the default install
  // must not pay connector-cursor's load.
  const { CURSOR_HOOKS_FILE, CURSOR_MCP_FILE } = await import(
    "@crosscheck/connector-cursor"
  );
  const dir = cursorUserDir(env);
  const hooksPath = join(dir, CURSOR_HOOKS_FILE);
  const mcpPath = join(dir, CURSOR_MCP_FILE);
  const hooks = await readJsonConfig(hooksPath);
  if (!hooks.ok) {
    return { ok: false, path: hooksPath };
  }
  const mcp = await readJsonConfig(mcpPath);
  if (!mcp.ok) {
    return { ok: false, path: mcpPath };
  }
  return {
    ok: true,
    hooksPath,
    hooksRaw: hooks.raw,
    hooksValue: hooks.value,
    mcpPath,
    mcpRaw: mcp.raw,
    mcpValue: mcp.value,
  };
};

const applyCursorInstall = async (
  reads: CursorReads,
  prefix: string,
  mcpEntry: McpServerEntry,
): Promise<readonly string[]> => {
  const { buildCursorHooksPlan, mergeCursorHooks } = await import(
    "@crosscheck/connector-cursor"
  );
  const hooksOutcome = await writeIfChanged(
    reads.hooksPath,
    reads.hooksRaw,
    renderJsonFile(mergeCursorHooks(reads.hooksValue, buildCursorHooksPlan(prefix))),
  );
  const mcpOutcome = await writeIfChanged(
    reads.mcpPath,
    reads.mcpRaw,
    renderJsonFile(mergeMcpConfig(reads.mcpValue, mcpEntry)),
  );
  return [
    wroteLine(hooksOutcome.path, hooksOutcome.wrote),
    wroteLine(mcpOutcome.path, mcpOutcome.wrote),
    // Scoped honestly: the documented limitation of Cursor's user level.
    "cursor user-level hooks cover local sessions only (Cursor cloud agents read committed .cursor/hooks.json, not ~/.cursor)",
  ];
};

/**
 * `--remove` sweeps ALL four user-scope files whatever flags the install
 * ran with — a removal that depends on remembering `--cursor` leaves
 * half-installed machines behind. Files that are missing are skipped;
 * files without crosscheck entries are reported as such; unparseable files
 * abort with nothing changed, exactly like install.
 */
const runGlobalRemove = async (env: Env): Promise<CliResult> => {
  const settingsPath = claudeUserSettingsPath(env);
  const mcpPath = claudeUserMcpPath(env);
  const { CURSOR_HOOKS_FILE, CURSOR_MCP_FILE, removeCursorHooks } = await import(
    "@crosscheck/connector-cursor"
  );
  const dir = cursorUserDir(env);
  const cursorHooksPath = join(dir, CURSOR_HOOKS_FILE);
  const cursorMcpPath = join(dir, CURSOR_MCP_FILE);

  const reads = new Map<string, ReadJson & { readonly ok: true }>();
  for (const path of [settingsPath, mcpPath, cursorHooksPath, cursorMcpPath]) {
    const read = await readJsonConfig(path);
    if (!read.ok) {
      return abortUnparseable(path);
    }
    reads.set(path, read);
  }

  const lines: string[] = [];
  const removeFrom = async (
    path: string,
    changed: boolean,
    value: Record<string, unknown>,
  ): Promise<void> => {
    const read = reads.get(path);
    if (read === undefined || read.raw === null) {
      return;
    }
    if (!changed) {
      lines.push(`no crosscheck entries in ${path}`);
      return;
    }
    await writeIfChanged(path, read.raw, renderJsonFile(value));
    lines.push(`removed crosscheck entries from ${path}`);
  };

  const settingsRead = reads.get(settingsPath);
  if (settingsRead !== undefined && settingsRead.raw !== null) {
    const removed = removeClaudeSettings(settingsRead.value);
    await removeFrom(settingsPath, removed.changed, removed.settings);
  }
  const mcpRead = reads.get(mcpPath);
  if (mcpRead !== undefined && mcpRead.raw !== null) {
    const removed = removeMcpConfig(mcpRead.value);
    await removeFrom(mcpPath, removed.changed, removed.config);
  }
  const cursorHooksRead = reads.get(cursorHooksPath);
  if (cursorHooksRead !== undefined && cursorHooksRead.raw !== null) {
    const removed = removeCursorHooks(cursorHooksRead.value);
    await removeFrom(cursorHooksPath, removed.changed, removed.hooks);
  }
  const cursorMcpRead = reads.get(cursorMcpPath);
  if (cursorMcpRead !== undefined && cursorMcpRead.raw !== null) {
    const removed = removeMcpConfig(cursorMcpRead.value);
    await removeFrom(cursorMcpPath, removed.changed, removed.config);
  }
  return {
    stdout: [
      ...(lines.length === 0 ? ["no user-level crosscheck install found"] : lines),
      // The mirror of the install-side restart hint: hooks already loaded
      // by a running agent stay loaded until that process restarts.
      "agents already running keep the removed hooks loaded until they are restarted",
      "",
    ].join("\n"),
    exitCode: EXIT_OK,
  };
};
