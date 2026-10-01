/**
 * The A2.2 shell-profile check, recorded in the manifest.
 *
 * WHY IT EXISTS. The env allowlist (exec.ts, A1.5) bounds what the harness
 * hands `claude`, but Claude Code's Bash tool sources the user's shell
 * profile, so a variable the profile exports reaches every command the agent
 * runs whatever the allowlist says. A2.2 states the residue and the fact that
 * makes it harmless on the measuring machine: none of its profile files sets
 * or exports a `CROSSCHECK_`, `CLAUDE_` or `ANTHROPIC_` variable. This module
 * is that check, so the statement is a recorded observation of the machine
 * the runs used, not a sentence in a doc.
 *
 * WHAT IT READS. The zsh and bash startup files under HOME (and under
 * ZDOTDIR when that differs), then the system-wide ones in /etc. A file that
 * is absent is recorded as absent; a file that exists but cannot be read
 * makes the check unclean, because it could export anything. A file the
 * profile `source`s is NOT followed: the record names exactly the files read.
 *
 * NAMES ONLY. A match records the variable NAME; the value is never captured,
 * so a profile holding a real key does not copy it into the results dir.
 *
 * STRICT BY CONSTRUCTION. Any assignment of a watched name counts, exported or
 * not, including a command-prefix assignment inside an alias — the check
 * errs toward unclean, the honest direction for an isolation claim.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** The variable prefixes A2.2 names. */
export const WATCHED_PREFIXES = ["CROSSCHECK_", "CLAUDE_", "ANTHROPIC_"] as const;

/** zsh startup files, read from HOME and from ZDOTDIR. */
const ZSH_FILES = [".zshenv", ".zprofile", ".zshrc", ".zlogin"] as const;

/** bash and POSIX-sh startup files, read from HOME. */
const BASH_FILES = [".bash_profile", ".bash_login", ".bashrc", ".profile"] as const;

/** The system-wide startup files both shells read before the user's. */
const SYSTEM_FILES = [
  "/etc/zshenv",
  "/etc/zprofile",
  "/etc/zshrc",
  "/etc/zlogin",
  "/etc/profile",
  "/etc/bashrc",
] as const;

const NAME = `(?:${WATCHED_PREFIXES.map((prefix) => prefix.slice(0, -1)).join("|")})_[A-Za-z0-9_]*`;

/** A watched name being assigned: `NAME=`/`NAME+=`, not part of a longer word or a `$`/`${` reference. */
const ASSIGNMENT = new RegExp(`(?<![A-Za-z0-9_$\\{])(${NAME})\\+?=`, "g");

/** A line that exports or declares names without necessarily assigning them. */
const EXPORT_STATEMENT = /(?:^|[\s;&|(])(?:export|typeset\s+-x|declare\s+-x|setenv)\s/;

/** Any bare watched name on an export line (not a `$`/`${` reference). */
const BARE_NAME = new RegExp(`(?<![A-Za-z0-9_$\\{])(${NAME})(?![A-Za-z0-9_])`, "g");

const namesMatching = (line: string, pattern: RegExp): string[] =>
  [...line.matchAll(pattern)].map((match) => match[1] ?? "").filter((name) => name.length > 0);

/**
 * The watched variable names a profile text sets or exports, unique and
 * sorted. Comment lines are skipped. Pure; never returns a value.
 */
export const watchedProfileNames = (text: string): readonly string[] => {
  const names = text
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .flatMap((line) => [
      ...namesMatching(line, ASSIGNMENT),
      ...(EXPORT_STATEMENT.test(line) ? namesMatching(line, BARE_NAME) : []),
    ]);
  return [...new Set(names)].sort();
};

/** The startup files the check reads, in a fixed order. */
export const profilePaths = (
  home: string,
  zdotdir: string | undefined,
): readonly string[] => [
  ...[...ZSH_FILES, ...BASH_FILES].map((name) => join(home, name)),
  ...(zdotdir === undefined || zdotdir === home
    ? []
    : ZSH_FILES.map((name) => join(zdotdir, name))),
  ...SYSTEM_FILES,
];

export interface ProfileFileCheck {
  readonly path: string;
  readonly present: boolean;
  /** False when the file exists but could not be read — that is unclean. */
  readonly readable: boolean;
  /** Watched names the file sets or exports (names only). */
  readonly watched: readonly string[];
}

export interface ProfileCheck {
  readonly prefixes: readonly string[];
  readonly files: readonly ProfileFileCheck[];
  /** True iff every present file was read and sets no watched name. */
  readonly clean: boolean;
}

const isMissing = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { code?: unknown }).code === "ENOENT";

const checkFile = async (path: string): Promise<ProfileFileCheck> => {
  try {
    const text = await readFile(path, "utf8");
    return { path, present: true, readable: true, watched: watchedProfileNames(text) };
  } catch (error) {
    return isMissing(error)
      ? { path, present: false, readable: false, watched: [] }
      : { path, present: true, readable: false, watched: [] };
  }
};

/** Reads each path and records what it sets; absent files are clean. */
export const checkShellProfiles = async (
  paths: readonly string[],
): Promise<ProfileCheck> => {
  const files = await Promise.all(paths.map(checkFile));
  const clean = files.every(
    (file) => !file.present || (file.readable && file.watched.length === 0),
  );
  return { prefixes: [...WATCHED_PREFIXES], files, clean };
};
