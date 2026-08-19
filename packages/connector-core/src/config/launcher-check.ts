/**
 * Launcher HEALTH probing — whether the command a hooks file names would
 * actually run — EXTRACTED VERBATIM from `connector-claude/src/cli/doctor.ts`
 * (`checkLauncher` + `splitLauncherTokens`) for Block 6: the Cursor doctor
 * section needs the identical resolves-AND-executes probes for the commands
 * in `.cursor/hooks.json` and cannot import from the Claude package. The one
 * generalization is the KEYWORD LIST — which subcommand token ends the
 * launcher prefix is host policy (`hook`/`statusline` for Claude,
 * `cursor-hook` for Cursor).
 *
 * Every check above this one in a doctor is textual, and the two states that
 * defeat textual checks are exactly the ones `init` guards against at write
 * time: a bare `crosscheck` that no longer resolves (hooks written from an
 * npx cache whose PATH prefix is gone), and a PATH `crosscheck` that is a
 * FOREIGN tool wearing the name. Hooks are silent by design, so a doctor is
 * the only place either state ever becomes a sentence.
 */
import { isAbsolute } from "node:path";

import type { Env } from "./paths.ts";
import {
  isEphemeralInstallPath,
  isOwnCrosscheckBin,
  realpathOrSelf,
} from "./launcher.ts";

export type LauncherHealthLevel = "PASS" | "WARN" | "FAIL";

export interface LauncherHealth {
  readonly level: LauncherHealthLevel;
  readonly detail: string;
}

const health = (
  level: LauncherHealthLevel,
  detail: string,
): LauncherHealth => ({ level, detail });

/**
 * Splits a hook command on whitespace, honouring the single-quoting that
 * `init`'s shellQuote produces (a path with an embedded quote tokenises
 * wrong — accepted: shellQuote's `'\''` escape is beyond a health check).
 */
export const splitLauncherTokens = (command: string): readonly string[] =>
  (command.match(/'[^']*'|\S+/g) ?? []).map((token) =>
    token.startsWith("'") && token.endsWith("'") && token.length >= 2
      ? token.slice(1, -1)
      : token,
  );

/** Whether the launcher the given hook command names would actually RUN. */
export const checkLauncherCommand = async (
  command: string,
  env: Env,
  keywords: readonly string[],
): Promise<LauncherHealth> => {
  const tokens = splitLauncherTokens(command);
  const keyword = tokens.findIndex((token) => keywords.includes(token));
  const launcherTokens = keyword === -1 ? tokens : tokens.slice(0, keyword);
  const head = launcherTokens[0];
  if (head === undefined) {
    return health("FAIL", "empty hook command");
  }

  if (head === "crosscheck") {
    const hit = ((): string | null => {
      try {
        return Bun.which("crosscheck", { PATH: env["PATH"] ?? "" });
      } catch {
        return null;
      }
    })();
    if (hit === null) {
      return health(
        "FAIL",
        'hooks call "crosscheck" but nothing by that name is on PATH — every hook dies silently; npm install -g crosscheck-hub (or bun add -g crosscheck-hub), or rerun crosscheck init',
      );
    }
    if (!(await isOwnCrosscheckBin(hit))) {
      return health(
        "FAIL",
        `${hit} does not identify as the crosscheck cli (--version) — a different tool owns the name on this PATH and would receive the hooks' session json; remove it or rerun crosscheck init --command-prefix with an explicit launcher`,
      );
    }
    const real = await realpathOrSelf(hit);
    if (isEphemeralInstallPath(real)) {
      return health(
        "WARN",
        `${hit} resolves into a package-runner cache (${real}) — it dies on cache eviction; install permanently and rerun crosscheck init`,
      );
    }
    return health("PASS", hit);
  }

  // Absolute-path launcher (`<runtime> <entry>`, as init writes without a
  // PATH hit) — plus whatever an operator's --command-prefix contains: the
  // absolute tokens are checkable, the rest is their word.
  const absoluteTokens = launcherTokens.filter((token) => isAbsolute(token));
  for (const token of absoluteTokens) {
    if (!(await Bun.file(token).exists())) {
      return health(
        "FAIL",
        `${token} does not exist — rerun crosscheck init`,
      );
    }
  }
  for (const token of absoluteTokens) {
    if (isEphemeralInstallPath(await realpathOrSelf(token))) {
      return health(
        "WARN",
        `${token} sits in a package-runner cache — it dies on cache eviction; install permanently and rerun crosscheck init`,
      );
    }
  }
  return absoluteTokens.length > 0
    ? health("PASS", launcherTokens.join(" "))
    : health(
        "PASS",
        `custom launcher not verified: ${launcherTokens.join(" ")}`,
      );
};
