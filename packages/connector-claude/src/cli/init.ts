import { join, resolve } from "node:path";
import { writeFile } from "node:fs/promises";

import {
  CLAUDE_SETTINGS_DIR,
  CLAUDE_SETTINGS_FILE,
  EXIT_ABORTED,
  EXIT_FAIL,
  EXIT_OK,
  MCP_CONFIG_FILE,
  POST_TOOL_USE_MATCHER,
  PRE_TOOL_USE_MATCHER,
} from "../constants.ts";
import { normalizeHubUrl, readStoredConfig } from "../config/config.ts";
import { crosscheckHome, ensureDir, readTextOrNull } from "../config/paths.ts";
import type { Env } from "../config/paths.ts";
import {
  readRepoConfig,
  renderRepoConfig,
  repoConfigPath,
} from "../config/repo-config.ts";
import { resolveRepoIdentity } from "../git/repo-identity.ts";
import { mergeMcpConfig } from "./mcp-config.ts";
import type { McpServerEntry } from "./mcp-config.ts";
import { mergeClaudeSettings } from "./settings-merge.ts";
import type { MatcherGroup, SettingsPlan } from "./settings-merge.ts";
import type { CliResult } from "./login.ts";

/** The connector's own entry point, resolved from this module's location. */
const BIN_ENTRY_PATH = resolve(import.meta.dir, "..", "bin", "crosscheck.ts");

/** Characters a POSIX shell passes through untouched. */
const SHELL_SAFE_PATTERN = /^[\w@%+=:,./-]+$/;

export interface InitOptions {
  readonly commandPrefix?: string | undefined;
  readonly hubUrl?: string | undefined;
  readonly forceStatusline: boolean;
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
  };
};

/** Single-quotes anything a shell would re-interpret, e.g. a path with spaces. */
const shellQuote = (value: string): string =>
  SHELL_SAFE_PATTERN.test(value)
    ? value
    : `'${value.split("'").join(`'\\''`)}'`;

const isOnPath = (command: string, env: Env): boolean => {
  try {
    return Bun.which(command, { PATH: env["PATH"] ?? "" }) !== null;
  } catch {
    return false;
  }
};

/**
 * Never emits a package name of its own accord. An unpublished one is a
 * dependency-confusion vector: whoever claims it on npm gets code execution in
 * every hook of every machine that ran `init`. Without `crosscheck` on PATH the
 * hooks are pointed at the absolute path of the entry point that is running
 * right now. An explicit `--command-prefix` is passed through as given — that
 * one is the operator's choice, made in the open.
 */
export const resolveCommandPrefix = async (
  override: string | undefined,
  env: Env,
): Promise<string> => {
  if (override !== undefined && override.length > 0) {
    return override;
  }
  if (isOnPath("crosscheck", env)) {
    return "crosscheck";
  }
  if (!(await Bun.file(BIN_ENTRY_PATH).exists())) {
    return "crosscheck";
  }
  return `${shellQuote(process.execPath)} ${shellQuote(BIN_ENTRY_PATH)}`;
};

/**
 * The MCP launcher, as `command` plus `args` rather than as a shell string.
 *
 * SAME NO-FETCHABLE-NAME PROPERTY AS `resolveCommandPrefix`, and it has to be
 * restated rather than reused: `.mcp.json` takes an argv, not a command line, so
 * the shell-quoted string that file produces cannot be dropped in. Everything
 * else about the decision is identical — an unpublished package name here would
 * be the same dependency-confusion hole, in a file that gets COMMITTED and so
 * reaches every teammate rather than only the machine that ran `init`.
 *
 * The `sh -c` branch is only for an explicit `--command-prefix`. An operator's
 * arbitrary launcher cannot be split into argv by guessing at quoting, and the
 * string is theirs, given in the open — the same trade `resolveCommandPrefix`
 * makes when it passes an override through untouched.
 */
export const resolveMcpLauncher = async (
  override: string | undefined,
  env: Env,
): Promise<McpServerEntry> => {
  if (override !== undefined && override.length > 0) {
    return { type: "stdio", command: "sh", args: ["-c", `${override} mcp`] };
  }
  if (isOnPath("crosscheck", env)) {
    return { type: "stdio", command: "crosscheck", args: ["mcp"] };
  }
  if (!(await Bun.file(BIN_ENTRY_PATH).exists())) {
    return { type: "stdio", command: "crosscheck", args: ["mcp"] };
  }
  return {
    type: "stdio",
    command: process.execPath,
    args: [BIN_ENTRY_PATH, "mcp"],
  };
};

export const buildSettingsPlan = (
  prefix: string,
  forceStatusline: boolean,
): SettingsPlan => {
  const group = (
    command: string,
    matcher?: string,
    isAsync?: boolean,
  ): MatcherGroup => ({
    ...(matcher === undefined ? {} : { matcher }),
    hooks: [
      {
        type: "command",
        command,
        ...(isAsync === true ? { async: true } : {}),
      },
    ],
  });
  return {
    hooks: {
      SessionStart: group(`${prefix} hook session-start`),
      PostToolUse: group(
        `${prefix} hook post-tool-use`,
        POST_TOOL_USE_MATCHER,
        true,
      ),
      SessionEnd: group(`${prefix} hook session-end`),
      // The injection pipeline (DESIGN.md §4): both SYNC, deliberately — one
      // returns additionalContext, the other a permission decision, and an
      // async hook can deliver neither.
      UserPromptSubmit: group(`${prefix} hook user-prompt-submit`),
      PreToolUse: group(`${prefix} hook pre-tool-use`, PRE_TOOL_USE_MATCHER),
      // The Tier-1 summarizer gate (DESIGN.md §3 Tier 1): ASYNC, because the
      // hook returns nothing — it gates deterministically and spawns the
      // detached worker; the model must never wait on it.
      Stop: group(`${prefix} hook stop`, undefined, true),
    },
    statusLine: { type: "command", command: `${prefix} statusline` },
    forceStatusline,
  };
};

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

  const settingsDir = join(identity.root, CLAUDE_SETTINGS_DIR);
  const settingsPath = join(settingsDir, CLAUDE_SETTINGS_FILE);
  const mcpPath = join(identity.root, MCP_CONFIG_FILE);

  // BOTH files are read and validated BEFORE either is written. `init` writing
  // settings.json and then aborting on an unparseable .mcp.json would leave the
  // repo half-installed — hooks registered, tools not — which is the state
  // `doctor` has the hardest time explaining.
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
  await backUp(settingsPath, settingsRead.raw);
  await backUp(mcpPath, mcpRead.raw);

  const prefix = await resolveCommandPrefix(options.commandPrefix, env);
  const merged = mergeClaudeSettings(
    settingsRead.value,
    buildSettingsPlan(prefix, options.forceStatusline),
  );
  const mcpEntry = await resolveMcpLauncher(options.commandPrefix, env);
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

  const notes = merged.statuslineInstalled
    ? []
    : [
        "statusline not installed (existing statusline preserved) — rerun with --force-statusline to replace",
      ];
  return {
    stdout: [
      `wrote ${repoConfigPath(identity.root)}`,
      `wrote ${settingsPath}`,
      `wrote ${mcpPath}`,
      `hooks use launcher: ${prefix}`,
      // Said explicitly because it is the ONLY delivery mechanism: a teammate
      // gets the tools from this file arriving in their checkout, and nowhere
      // else. An uncommitted .mcp.json is an install that works for one person.
      `commit ${MCP_CONFIG_FILE} so teammates get the mcp tools on git pull`,
      ...notes,
      "",
    ].join("\n"),
    exitCode: EXIT_OK,
  };
};
