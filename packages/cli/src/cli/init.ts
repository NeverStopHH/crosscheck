import { join, resolve } from "node:path";
import { writeFile } from "node:fs/promises";

import {
  CLAUDE_SETTINGS_DIR,
  CLAUDE_SETTINGS_FILE,
  EXIT_ABORTED,
  EXIT_FAIL,
  EXIT_OK,
  MCP_CONFIG_FILE,
} from "@crosscheck/connector-core/constants.ts";
import { normalizeHubUrl, readStoredConfig } from "@crosscheck/connector-core/config/config.ts";
import { crosscheckHome, ensureDir, readTextOrNull } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import {
  readRepoConfig,
  renderRepoConfig,
  repoConfigPath,
} from "@crosscheck/connector-core/config/repo-config.ts";
import { resolveRepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import { mergeMcpConfig } from "@crosscheck/connector-core/config/mcp-config.ts";
import {
  resolveCommandPrefix,
  resolveLauncher as resolveLauncherWithEntry,
  resolveMcpLauncher,
} from "@crosscheck/connector-core/config/launcher.ts";
import type { Launcher } from "@crosscheck/connector-core/config/launcher.ts";
import { buildSettingsPlan, mergeClaudeSettings } from "@crosscheck/connector-claude";
import type { CliResult } from "./login.ts";

/** The connector's own entry point, resolved from this module's location. */
const BIN_ENTRY_PATH = resolve(import.meta.dir, "..", "bin", "crosscheck.ts");

export interface InitOptions {
  readonly commandPrefix?: string | undefined;
  readonly hubUrl?: string | undefined;
  readonly forceStatusline: boolean;
  /** COMPOSABLE with the default install (design §3.4): adds Cursor's files. */
  readonly cursor: boolean;
}

export const parseInitArgs = (args: readonly string[]): InitOptions => {
  const flagValue = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };
  return {
    commandPrefix: flagValue("--command-prefix"),
    hubUrl: flagValue("--hub"),
    forceStatusline: args.includes("--force-statusline"),
    cursor: args.includes("--cursor"),
  };
};

/**
 * Launcher resolution MOVED to core for Block 5
 * (@crosscheck/connector-core/config/launcher.ts) — the ACP proxy's
 * mcpServers injection needs the identical durable-install rules and cannot
 * import from this package. Re-exported here so existing consumers (doctor,
 * tests) keep their import site; the one local addition is the default entry
 * path, which core cannot know.
 */
export {
  isEphemeralInstallPath,
  isOwnCrosscheckBin,
  realpathOrSelf,
  resolveCommandPrefix,
  resolveMcpLauncher,
} from "@crosscheck/connector-core/config/launcher.ts";
export type { Launcher } from "@crosscheck/connector-core/config/launcher.ts";

export const resolveLauncher = async (
  override: string | undefined,
  env: Env,
  entryPath: string = BIN_ENTRY_PATH,
): Promise<Launcher> => resolveLauncherWithEntry(override, env, entryPath);

const renderSettings = (settings: Record<string, unknown>): string =>
  `${JSON.stringify(settings, null, 2)}\n`;

type ReadJson =
  | { readonly ok: true; readonly value: Record<string, unknown>; readonly raw: string | null }
  | { readonly ok: false };

/**
 * Reads a JSON config `init` is going to rewrite, or refuses.
 *
 * Refusing is the point. A file that cannot be parsed is a file whose contents
 * cannot be preserved, and overwriting it would silently delete a teammate's
 * configuration — so `init` changes NOTHING and says which file stopped it. Both
 * `.claude/settings.json` and `.mcp.json` obey this, which is why it is one
 * function rather than two copies of the same four lines.
 */
const readJsonConfig = async (path: string): Promise<ReadJson> => {
  const raw = await readTextOrNull(path);
  if (raw === null) {
    return { ok: true, value: {}, raw: null };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return {
      ok: true,
      value:
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {},
      raw,
    };
  } catch {
    return { ok: false };
  }
};

/** Timestamped backup beside the original, so a bad merge is recoverable. */
const backUp = async (path: string, raw: string | null): Promise<void> => {
  if (raw !== null) {
    await writeFile(`${path}.bak-${String(Date.now())}`, raw, "utf8");
  }
};

type ResolvedInputs = { readonly hubUrl: string } | { readonly error: string };

/**
 * The hub URL and the api key are resolved separately on purpose. A cloned repo
 * carries the hub URL in its committed `.crosscheck.json` while the key lives
 * only in `~/.crosscheck/config.json`, so the two are missing for different
 * reasons and a combined lookup would blame the wrong one.
 */
const resolveInputs = async (
  options: InitOptions,
  env: Env,
  repoRoot: string,
): Promise<ResolvedInputs> => {
  const repoConfig = await readRepoConfig(repoRoot);
  const stored = await readStoredConfig(crosscheckHome(env));
  const candidate =
    options.hubUrl ??
    env["CROSSCHECK_HUB_URL"] ??
    repoConfig?.hubUrl ??
    stored?.hubUrl;
  if (candidate === undefined) {
    return { error: "no hub url — run `crosscheck login <hubUrl>` first" };
  }
  const hubUrl = normalizeHubUrl(candidate);
  if (hubUrl === null) {
    return { error: `invalid hub url: ${candidate}` };
  }
  const apiKey = env["CROSSCHECK_API_KEY"] ?? stored?.apiKey;
  if (apiKey === undefined) {
    return {
      error: `no api key for ${hubUrl} — run \`crosscheck login ${hubUrl}\` first`,
    };
  }
  return { hubUrl };
};

export const runInit = async (
  args: readonly string[],
  env: Env,
  cwd: string,
): Promise<CliResult> => {
  const options = parseInitArgs(args);
  const identity = await resolveRepoIdentity(cwd);
  if (identity === null) {
    return { stdout: "not a git repository\n", exitCode: EXIT_FAIL };
  }
  const resolved = await resolveInputs(options, env, identity.root);
  if ("error" in resolved) {
    return { stdout: `${resolved.error}\n`, exitCode: EXIT_FAIL };
  }
  const { hubUrl } = resolved;

  // Resolved BEFORE anything is read or written: a refused launcher must
  // leave the repo exactly as it found it.
  const launcher = await resolveLauncher(options.commandPrefix, env);
  if (launcher.kind === "refused") {
    return { stdout: `${launcher.reason}\n`, exitCode: EXIT_FAIL };
  }

  const settingsDir = join(identity.root, CLAUDE_SETTINGS_DIR);
  const settingsPath = join(settingsDir, CLAUDE_SETTINGS_FILE);
  const mcpPath = join(identity.root, MCP_CONFIG_FILE);

  // ALL files are read and validated BEFORE any is written — the Cursor pair
  // included when --cursor rides along. `init` writing settings.json and then
  // aborting on an unparseable .mcp.json (or .cursor/hooks.json) would leave
  // the repo half-installed — hooks registered, tools not — which is the
  // state `doctor` has the hardest time explaining.
  const settingsRead = await readJsonConfig(settingsPath);
  if (!settingsRead.ok) {
    return {
      stdout: `${settingsPath} is not valid json — nothing was changed\n`,
      exitCode: EXIT_ABORTED,
    };
  }
  const mcpRead = await readJsonConfig(mcpPath);
  if (!mcpRead.ok) {
    return {
      stdout: `${mcpPath} is not valid json — nothing was changed\n`,
      exitCode: EXIT_ABORTED,
    };
  }
  const prefix = resolveCommandPrefix(launcher);
  const mcpEntry = resolveMcpLauncher(launcher);
  // DYNAMIC import like the bin's cursor-hook branch: hooks and the
  // statusline must not pay connector-cursor's load. Prepare/apply split so
  // the Cursor files are validated HERE, written only after the Claude
  // writes below succeed (all-or-nothing across both connectors).
  const cursorPlan = options.cursor
    ? await (async () => {
        const { prepareCursorInit } = await import(
          "@crosscheck/connector-cursor"
        );
        return prepareCursorInit(identity.root, prefix, mcpEntry);
      })()
    : null;
  if (cursorPlan !== null && !cursorPlan.ok) {
    return {
      stdout: `${cursorPlan.reason}\n`,
      exitCode: EXIT_ABORTED,
    };
  }
  await backUp(settingsPath, settingsRead.raw);
  await backUp(mcpPath, mcpRead.raw);

  const merged = mergeClaudeSettings(
    settingsRead.value,
    buildSettingsPlan(prefix, options.forceStatusline),
  );
  await ensureDir(settingsDir);
  await writeFile(settingsPath, renderSettings(merged.settings), "utf8");
  await writeFile(
    mcpPath,
    renderSettings(mergeMcpConfig(mcpRead.value, mcpEntry)),
    "utf8",
  );
  await writeFile(
    repoConfigPath(identity.root),
    renderRepoConfig(hubUrl),
    "utf8",
  );
  const cursorPaths =
    cursorPlan !== null && cursorPlan.ok ? await cursorPlan.apply() : [];

  const notes = [
    ...(merged.statuslineInstalled
      ? []
      : [
          "statusline not installed (existing statusline preserved) — rerun with --force-statusline to replace",
        ]),
    // The entry launcher is an absolute path of THIS machine. It runs here —
    // that is the point — but the committed .mcp.json will not run for a
    // teammate until they rerun init (or put crosscheck on PATH) themselves.
    ...(launcher.kind === "entry"
      ? [
          "launcher is an absolute path on this machine — teammates must run crosscheck init once too (or npm install -g crosscheck-hub)",
        ]
      : []),
  ];
  return {
    stdout: [
      `wrote ${repoConfigPath(identity.root)}`,
      `wrote ${settingsPath}`,
      `wrote ${mcpPath}`,
      ...cursorPaths.map((path) => `wrote ${path}`),
      `hooks use launcher: ${prefix}`,
      // Said explicitly because it is the ONLY delivery mechanism: a teammate
      // gets the tools from this file arriving in their checkout, and nowhere
      // else. An uncommitted .mcp.json is an install that works for one person.
      `commit ${MCP_CONFIG_FILE} so teammates get the mcp tools on git pull`,
      // The same one-PR rule for the Cursor pair — and the gitignore warning
      // the design's rules-file rejection earned: an ignored .cursor/ is an
      // install that silently works for one person only.
      ...(cursorPaths.length > 0
        ? [
            "commit the .cursor files too (Cursor loads project hooks from version control in trusted workspaces) — if .cursor/ is gitignored, unignore hooks.json + mcp.json or teammates never get them",
          ]
        : []),
      ...notes,
      "",
    ].join("\n"),
    exitCode: EXIT_OK,
  };
};
