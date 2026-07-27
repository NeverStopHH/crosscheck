import { join, resolve } from "node:path";
import { writeFile } from "node:fs/promises";

import {
  CLAUDE_SETTINGS_DIR,
  CLAUDE_SETTINGS_FILE,
  EXIT_ABORTED,
  EXIT_FAIL,
  EXIT_OK,
  POST_TOOL_USE_MATCHER,
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
    },
    statusLine: { type: "command", command: `${prefix} statusline` },
    forceStatusline,
  };
};

const renderSettings = (settings: Record<string, unknown>): string =>
  `${JSON.stringify(settings, null, 2)}\n`;

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
  const existingRaw = await readTextOrNull(settingsPath);
  let existing: Record<string, unknown> = {};
  if (existingRaw !== null) {
    try {
      const parsed = JSON.parse(existingRaw) as unknown;
      existing =
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
    } catch {
      return {
        stdout: `${settingsPath} is not valid json — nothing was changed\n`,
        exitCode: EXIT_ABORTED,
      };
    }
    await writeFile(
      `${settingsPath}.bak-${Date.now()}`,
      existingRaw,
      "utf8",
    );
  }

  const prefix = await resolveCommandPrefix(options.commandPrefix, env);
  const merged = mergeClaudeSettings(
    existing,
    buildSettingsPlan(prefix, options.forceStatusline),
  );
  await ensureDir(settingsDir);
  await writeFile(settingsPath, renderSettings(merged.settings), "utf8");
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
      `hooks use launcher: ${prefix}`,
      ...notes,
      "",
    ].join("\n"),
    exitCode: EXIT_OK,
  };
};
