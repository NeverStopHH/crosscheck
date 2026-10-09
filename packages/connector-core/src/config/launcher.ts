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
import { selfLaunch } from "./runtime-isolation.ts";
import type { SelfLaunch } from "./runtime-isolation.ts";
import { trustedPath, untrustedPathEntries } from "./trusted-path.ts";

/** Characters a POSIX shell passes through untouched. */
const SHELL_SAFE_PATTERN = /^[\w@%+=:,./-]+$/;

/** Single-quotes anything a shell would re-interpret, e.g. a path with spaces. */
export const shellQuote = (value: string): string =>
  SHELL_SAFE_PATTERN.test(value)
    ? value
    : `'${value.split("'").join(`'\\''`)}'`;

/** A PATH lookup that skips relative and in-repo entries (trusted-path.ts). */
const whichOnPath = (command: string, env: Env): string | null => {
  try {
    return Bun.which(command, { PATH: trustedPath(env["PATH"] ?? "", process.cwd()) });
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

/** How long, and how often, `<bin> --version` may take to identify itself. */
export interface IdentityProbeBudget {
  readonly timeoutMs: number;
  readonly attempts: number;
}

/**
 * Plenty for `crosscheck --version` through the node shim's re-exec hop on a
 * quiet machine. The budget wherever the answer is waited for inside someone
 * else's time: the ACP proxy resolves its injected MCP entry under a
 * session-setup deadline, and doctor's launcher line is one check of many.
 */
export const DEFAULT_IDENTITY_PROBE: IdentityProbeBudget = { timeoutMs: 3_000, attempts: 1 };

/**
 * INIT'S BUDGET. Under load (about 20) the shim's re-exec hop ran past 3 s,
 * and init quietly wrote the absolute launcher (batch 2). init is a one-off a
 * person starts and waits for, so it waits longer and asks once more.
 */
export const INIT_IDENTITY_PROBE: IdentityProbeBudget = { timeoutMs: 10_000, attempts: 2 };

/** What `<bin> --version` said: our banner, anything else, or nothing before the deadline. */
export type BinIdentity = "own" | "foreign" | "silent";

/**
 * Executes `<bin> --version` and accepts only our own banner. The NAME
 * `crosscheck` on a PATH proves nothing: npm's `crosscheck-cli` package
 * installs a bin of exactly this name, and hooks wired to a stranger's
 * binary would pipe session json into it on every prompt — silently, because
 * hooks never print. Identity is proven by execution, not by name. A bin that
 * says nothing in time is `silent`, which is not the same as foreign: it may
 * be ours on a busy machine, and the caller decides whether to ask again.
 */
/**
 * The same three answers by the name doctor's launcher line reads them
 * (config/launcher-check.ts): `silent` is not proof of a stranger — under CPU
 * contention the first exec of a freshly installed launcher outlived the
 * deadline, and reading that as "foreign" had doctor tell a developer to
 * remove their own working install.
 */
export type CrosscheckBinIdentity = BinIdentity;

export const probeCrosscheckBin = async (
  binPath: string,
  timeoutMs: number = DEFAULT_IDENTITY_PROBE.timeoutMs,
): Promise<BinIdentity> => {
  let probe: Bun.Subprocess<"ignore", "pipe", "ignore">;
  try {
    probe = Bun.spawn({ cmd: [binPath, "--version"], stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  } catch {
    // Could not be executed at all: it cannot run as a hook either.
    return "foreign";
  }
  const answered = (async (): Promise<BinIdentity> => {
    const stdout = await new Response(probe.stdout).text();
    return (await probe.exited) === 0 && OWN_VERSION_PATTERN.test(stdout.trim()) ? "own" : "foreign";
  })();
  // A late answer after the deadline must not surface as an unhandled rejection.
  answered.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"silent">((resolveDeadline) => {
    timer = setTimeout(() => resolveDeadline("silent"), timeoutMs);
  });
  try {
    const identity = await Promise.race([answered, deadline]);
    if (identity === "silent") {
      // SIGTERM, which the node shim forwards to its bun child.
      probe.kill();
    }
    return identity;
  } catch {
    return "foreign";
  } finally {
    clearTimeout(timer);
  }
};

export const isOwnCrosscheckBin = async (binPath: string): Promise<boolean> =>
  (await probeCrosscheckBin(binPath)) === "own";

/** The probe within a budget: asked again only while it stays silent. */
const identifyWithin = async (binPath: string, budget: IdentityProbeBudget): Promise<BinIdentity> => {
  let identity: BinIdentity = "silent";
  for (let attempt = 0; attempt < budget.attempts && identity === "silent"; attempt += 1) {
    identity = await probeCrosscheckBin(binPath, budget.timeoutMs);
  }
  return identity;
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
  // The absolute form carries its finished, isolated start and nothing a
  // caller could reassemble without the flags (config/runtime-isolation.ts).
  // `silentBare`: the `crosscheck` on PATH that did not identify itself in
  // time, when that is why this form was chosen (`silentBareNote`).
  | { readonly kind: "entry"; readonly launch: SelfLaunch; readonly silentBare?: string }
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
  identityBudget: IdentityProbeBudget = DEFAULT_IDENTITY_PROBE,
): Promise<Launcher> => {
  if (override !== undefined && override.length > 0) {
    return { kind: "override", prefix: override };
  }
  const hit = whichOnPath("crosscheck", env);
  // The host resolves a bare `crosscheck` through the developer's whole PATH
  // at hook time, so with a relative or in-repo entry on it the name is a
  // repo's to answer: the absolute form below is written instead.
  const identity =
    hit !== null &&
    untrustedPathEntries(env["PATH"] ?? "", process.cwd()).length === 0 &&
    !isEphemeralInstallPath(await realpathOrSelf(hit))
      ? await identifyWithin(hit, identityBudget)
      : null;
  if (hit !== null && identity === "own") {
    return { kind: "bare", path: hit };
  }
  // A rejected PATH hit falls THROUGH rather than erroring: the absolute
  // entry launcher works regardless of what else answers to the name.
  if (await Bun.file(entryPath).exists()) {
    if (isEphemeralInstallPath(await realpathOrSelf(entryPath))) {
      return { kind: "refused", reason: CACHE_REFUSAL };
    }
    const launch = selfLaunch(entryPath);
    return hit !== null && identity === "silent" ? { kind: "entry", launch, silentBare: hit } : { kind: "entry", launch };
  }
  return { kind: "refused", reason: NO_LAUNCHER_REFUSAL };
};

/**
 * The one line an install prints when a `crosscheck` on PATH stayed silent
 * and the absolute launcher was wired instead; null otherwise. Never a silent
 * fallback: the bare name follows upgrades and the absolute path does not.
 */
export const silentBareNote = (launcher: UsableLauncher): string | null =>
  launcher.kind === "entry" && launcher.silentBare !== undefined
    ? `crosscheck on PATH (${launcher.silentBare}) didn't answer in time; wired the absolute launcher ${resolveCommandPrefix(launcher)} instead; rerun init to switch`
    : null;

/** The hook/statusline command prefix, as one shell string. */
export const resolveCommandPrefix = (launcher: UsableLauncher): string => {
  switch (launcher.kind) {
    case "override":
      return launcher.prefix;
    case "bare":
      return "crosscheck";
    case "entry":
      // Isolated from the repo it runs in (config/runtime-isolation.ts): the
      // hook fires with the project as cwd, and bun would read its bunfig
      // preload and .env first.
      return [launcher.launch.command, ...launcher.launch.args].map(shellQuote).join(" ");
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
        command: launcher.launch.command,
        args: [...launcher.launch.args, "mcp"],
      };
  }
};
