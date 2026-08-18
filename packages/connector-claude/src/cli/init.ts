import { join, resolve, sep } from "node:path";
import { realpath, writeFile } from "node:fs/promises";

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

const whichOnPath = (command: string, env: Env): string | null => {
  try {
    return Bun.which(command, { PATH: env["PATH"] ?? "" });
  } catch {
    return null;
  }
};

/**
 * A launcher path inside a package-runner cache. npm's npx keeps installs
 * under a `_npx` cache segment, bun's bunx under `bunx-<uid>-<pkg>` temp dirs
 * (HISTORICAL: observed 2026-08-16 as ~/.npm/_npx/<hash>/node_modules/.bin/
 * crosscheck and $TMPDIR/bunx-501-crosscheck@latest/node_modules/.bin/…;
 * since the publish rename the bunx dir is bunx-501-crosscheck-hub@latest —
 * only the `bunx-` prefix is matched, so the rename changed nothing here).
 * Both die on cache eviction — and the PATH prefix that made a bare name
 * resolve is gone the moment the runner exits — so nothing under them may be
 * written into hooks that must still run next month.
 */
export const isEphemeralInstallPath = (path: string): boolean =>
  path
    .split(sep)
    .some((segment) => segment === "_npx" || segment.startsWith("bunx-"));

/** Symlinks (npm's .bin) resolved so the cache test sees the real location. */
export const realpathOrSelf = async (path: string): Promise<string> => {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
};

/** What our own bin prints for `--version`; a foreign tool prints anything else. */
const OWN_VERSION_PATTERN = /^crosscheck \d+\.\d+\.\d+/;
/** Plenty for `crosscheck --version` even through the node shim's re-exec hop. */
const IDENTITY_PROBE_TIMEOUT_MS = 3_000;

/**
 * Executes `<bin> --version` and accepts only our own banner. The NAME
 * `crosscheck` on a PATH proves nothing: npm's `crosscheck-cli` package
 * installs a bin of exactly this name, and hooks wired to a stranger's
 * binary would pipe session json into it on every prompt — silently, because
 * hooks never print. Identity is proven by execution, not by name.
 */
export const isOwnCrosscheckBin = async (binPath: string): Promise<boolean> => {
  try {
    const probe = Bun.spawn({
      cmd: [binPath, "--version"],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: IDENTITY_PROBE_TIMEOUT_MS,
    });
    const stdout = await new Response(probe.stdout).text();
    return (await probe.exited) === 0 && OWN_VERSION_PATTERN.test(stdout.trim());
  } catch {
    return false;
  }
};

/**
 * The one launcher decision both files are derived from. Everything below is
 * a way of NOT writing a command that dies after `init` returns:
 *
 *   - `override`: the operator's word, passed through untouched.
 *   - `bare`: `crosscheck` on PATH — only after it survives BOTH guards:
 *     it is not resolved out of an npx/bunx cache (the PATH prefix that found
 *     it disappears with the runner), and its `--version` identifies as ours
 *     (a foreign tool owning the name must never receive our session json).
 *   - `entry`: the absolute path of the entry point that is running right
 *     now — never a package name, because an unpublished name is a
 *     dependency-confusion vector: whoever claims it on npm gets code
 *     execution in every hook of every machine that ran `init`.
 *   - `refused`: even the running entry sits in an npx/bunx cache (this is
 *     `npx crosscheck-hub init`), so every writable path dies with the cache.
 *     Hooks fail silently by design, which is why this refuses loudly here.
 */
export type Launcher =
  | { readonly kind: "override"; readonly prefix: string }
  | { readonly kind: "bare" }
  | { readonly kind: "entry"; readonly runtime: string; readonly entry: string }
  | { readonly kind: "refused"; readonly reason: string };

type UsableLauncher = Exclude<Launcher, { kind: "refused" }>;

// The install commands name the npm PACKAGE (`crosscheck-hub` — npm's
// similarity rule refused `crosscheck`); the installed COMMAND stays
// `crosscheck`, which is why `rerun crosscheck init` follows unchanged.
const CACHE_REFUSAL =
  "refusing to wire hooks from an npx/bunx cache: every launcher path " +
  "available here dies with the cache, and hooks fail silently by design. " +
  "Install it permanently first — npm install -g crosscheck-hub (or bun " +
  "add -g crosscheck-hub) — then rerun crosscheck init; or pass " +
  "--command-prefix.";

const NO_LAUNCHER_REFUSAL =
  "no usable launcher: nothing named crosscheck on PATH and the running " +
  "entry point is gone — npm install -g crosscheck-hub (or bun add -g " +
  "crosscheck-hub), then rerun crosscheck init.";

export const resolveLauncher = async (
  override: string | undefined,
  env: Env,
  entryPath: string = BIN_ENTRY_PATH,
): Promise<Launcher> => {
  if (override !== undefined && override.length > 0) {
    return { kind: "override", prefix: override };
  }
  const hit = whichOnPath("crosscheck", env);
  if (
    hit !== null &&
    !isEphemeralInstallPath(await realpathOrSelf(hit)) &&
    (await isOwnCrosscheckBin(hit))
  ) {
    return { kind: "bare" };
  }
  // A rejected PATH hit falls THROUGH rather than erroring: the absolute
  // entry launcher works regardless of what else answers to the name.
  if (await Bun.file(entryPath).exists()) {
    if (isEphemeralInstallPath(await realpathOrSelf(entryPath))) {
      return { kind: "refused", reason: CACHE_REFUSAL };
    }
    return { kind: "entry", runtime: process.execPath, entry: entryPath };
  }
  return { kind: "refused", reason: NO_LAUNCHER_REFUSAL };
};

/** The hook/statusline command prefix, as one shell string. */
export const resolveCommandPrefix = (launcher: UsableLauncher): string => {
  switch (launcher.kind) {
    case "override":
      return launcher.prefix;
    case "bare":
      return "crosscheck";
    case "entry":
      return `${shellQuote(launcher.runtime)} ${shellQuote(launcher.entry)}`;
  }
};

/**
 * The MCP launcher, as `command` plus `args` rather than as a shell string:
 * `.mcp.json` takes an argv, so the shell-quoted prefix cannot be dropped in.
 *
 * The `sh -c` branch is only for an explicit `--command-prefix`. An operator's
 * arbitrary launcher cannot be split into argv by guessing at quoting, and the
 * string is theirs, given in the open — the same trade `resolveCommandPrefix`
 * makes when it passes an override through untouched.
 */
export const resolveMcpLauncher = (launcher: UsableLauncher): McpServerEntry => {
  switch (launcher.kind) {
    case "override":
      return {
        type: "stdio",
        command: "sh",
        args: ["-c", `${launcher.prefix} mcp`],
      };
    case "bare":
      return { type: "stdio", command: "crosscheck", args: ["mcp"] };
    case "entry":
      return {
        type: "stdio",
        command: launcher.runtime,
        args: [launcher.entry, "mcp"],
      };
  }
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

  // Resolved BEFORE anything is read or written: a refused launcher must
  // leave the repo exactly as it found it.
  const launcher = await resolveLauncher(options.commandPrefix, env);
  if (launcher.kind === "refused") {
    return { stdout: `${launcher.reason}\n`, exitCode: EXIT_FAIL };
  }

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

  const prefix = resolveCommandPrefix(launcher);
  const merged = mergeClaudeSettings(
    settingsRead.value,
    buildSettingsPlan(prefix, options.forceStatusline),
  );
  const mcpEntry = resolveMcpLauncher(launcher);
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
