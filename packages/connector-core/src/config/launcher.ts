/**
 * Launcher resolution — the durable-install rules, MOVED (mechanically, for
 * Block 5) from `connector-claude/src/cli/init.ts` so the ACP proxy's
 * mcpServers injection resolves its launcher through the SAME rules the
 * Claude installer wires hooks with (design §2.5: "Launcher path resolution
 * reuses init.ts's rule"). One implementation; connector-claude re-exports.
 *
 * The one signature change of the move: `resolveLauncher` REQUIRES the
 * caller's entry path — core cannot know which bin is running (the Claude
 * CLI passes its own entry module's path; the ACP proxy passes `Bun.main`).
 */
import { sep } from "node:path";
import { realpath } from "node:fs/promises";

import type { Env } from "./paths.ts";
import type { McpServerEntry } from "./mcp-config.ts";

/** Characters a POSIX shell passes through untouched. */
const SHELL_SAFE_PATTERN = /^[\w@%+=:,./-]+$/;

/** Single-quotes anything a shell would re-interpret, e.g. a path with spaces. */
export const shellQuote = (value: string): string =>
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
 * written into hooks or mcpServers entries that must still run next month.
 */
export const isEphemeralInstallPath = (path: string): boolean =>
  path
    .split(sep)
    .some((segment) => segment === "_npx" || segment.startsWith("bunx-"));

/**
 * A launcher path that belongs to ONE runtime version, chosen by a version
 * manager (trial finding M9).
 *
 * `~/.nvm/versions/node/v22.4.0/bin/crosscheck` answers `--version` correctly
 * and is not a package-runner cache, so `resolveLauncher` below calls it
 * `bare` and `init` writes the naked command `crosscheck` into every hook.
 * That works until `nvm use 20`, at which point the name is gone from PATH and
 * every hook fire exits 127. It is LOUD — Claude Code prints a "<hook> hook
 * error" per fire — but the capture is lost for as long as it lasts, and the
 * entry form (`<bun> <entry.ts>`) survives it.
 *
 * The four segments are the version managers that hand each runtime version
 * its own bin directory: nvm, fnm, Volta's tool image, and asdf's nodejs
 * installs. A global npm prefix that happens to live under a version manager
 * hits the same problem for the same reason, which is why the match is on the
 * path shape rather than on any one tool's name.
 *
 * IT DOES NOT CHANGE `resolveLauncher`'s VERDICT. Silently switching to the
 * entry form would rewrite every existing install's hook commands to an
 * absolute path of one machine — a worse failure for the many to fix a real
 * one for the few. Instead `init` prints a note naming `--command-prefix`, and
 * `checkLauncherCommand` (config/launcher-check.ts) turns the bare PASS into a
 * WARN that names nvm and the pin command.
 */
export const isVersionManagerPath = (path: string): boolean => {
  const segments = path.split(sep);
  const hasPair = (first: string, second: string): boolean =>
    segments.some(
      (segment, index) => segment === first && segments[index + 1] === second,
    );
  return (
    segments.includes(".nvm") ||
    segments.includes(".fnm") ||
    // Volta keeps every installed runtime under tools/image/node/<version>.
    hasPair("image", "node") ||
    // asdf: ~/.asdf/installs/nodejs/<version>/bin
    hasPair("installs", "nodejs")
  );
};

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
 * The one launcher decision every install surface derives from. Everything
 * below is a way of NOT writing a command that dies after the writer returns:
 *
 *   - `override`: the operator's word, passed through untouched.
 *   - `bare`: `crosscheck` on PATH — only after it survives BOTH guards:
 *     it is not resolved out of an npx/bunx cache (the PATH prefix that found
 *     it disappears with the runner), and its `--version` identifies as ours
 *     (a foreign tool owning the name must never receive our session json).
 *     Carries the resolved absolute path for writers that need one (the ACP
 *     mcpServers entry — an agent may spawn the server under a trimmed PATH).
 *   - `entry`: the absolute path of the entry point that is running right
 *     now — never a package name, because an unpublished name is a
 *     dependency-confusion vector: whoever claims it on npm gets code
 *     execution in every hook of every machine that ran `init`.
 *   - `refused`: even the running entry sits in an npx/bunx cache (this is
 *     `npx crosscheck-hub init`), so every writable path dies with the cache.
 *     Hooks fail silently by design, which is why callers refuse loudly.
 */
export type Launcher =
  | { readonly kind: "override"; readonly prefix: string }
  | { readonly kind: "bare"; readonly path: string }
  | { readonly kind: "entry"; readonly runtime: string; readonly entry: string }
  | { readonly kind: "refused"; readonly reason: string };

export type UsableLauncher = Exclude<Launcher, { kind: "refused" }>;

// The install commands name the npm PACKAGE (`crosscheck-hub` — npm's
// similarity rule refused `crosscheck`); the installed COMMAND stays
// `crosscheck`, which is why `rerun crosscheck init` follows unchanged.
export const CACHE_REFUSAL =
  "refusing to wire hooks from an npx/bunx cache: every launcher path " +
  "available here dies with the cache, and hooks fail silently by design. " +
  "Install it permanently first — npm install -g crosscheck-hub (or bun " +
  "add -g crosscheck-hub) — then rerun crosscheck init; or pass " +
  "--command-prefix.";

export const NO_LAUNCHER_REFUSAL =
  "no usable launcher: nothing named crosscheck on PATH and the running " +
  "entry point is gone — npm install -g crosscheck-hub (or bun add -g " +
  "crosscheck-hub), then rerun crosscheck init.";

export const resolveLauncher = async (
  override: string | undefined,
  env: Env,
  entryPath: string,
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
    return { kind: "bare", path: hit };
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
