/**
 * The file discipline both inits share (project `init.ts`, user-level
 * `init-global.ts`): read-and-refuse for unparseable JSON, timestamped
 * backups, and — new with the global install (finding #11) — ATOMIC,
 * idempotence-aware writes, because ~/.claude/settings.json and
 * ~/.claude.json belong to the USER and to Claude Code itself, not to a
 * repo: a half-written file there breaks every session on the machine, and
 * a backup for a byte-identical no-op re-run would litter a directory the
 * user lives in.
 */
import { rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { ensureDir } from "@crosscheck/connector-core/config/paths.ts";

export const renderJsonFile = (value: Record<string, unknown>): string =>
  `${JSON.stringify(value, null, 2)}\n`;

/** Why a read refused — each maps to the sentence init prints before aborting. */
export type ReadRefusal = "unreadable" | "unparseable" | "not-object";

export type ReadJson =
  | { readonly ok: true; readonly value: Record<string, unknown>; readonly raw: string | null }
  | { readonly ok: false; readonly reason: ReadRefusal };

/** The core clause naming why a file resisted preservation. */
const REFUSAL_CLAUSE: Readonly<Record<ReadRefusal, string>> = {
  unreadable: "could not be read",
  unparseable: "is not valid json",
  "not-object": "is not a json object",
};

/** Install's abort sentence — the JSON IS valid in the not-object case. */
export const refusalMessage = (path: string, reason: ReadRefusal): string =>
  `${path} ${REFUSAL_CLAUSE[reason]} — nothing was changed`;

/**
 * Remove's per-file skip sentence: a file crosscheck cannot parse is, by
 * definition of being unwritable, a file crosscheck never wrote — it holds
 * none of our entries, so removal skips it and cleans the rest rather than
 * aborting the whole uninstall over an unrelated editor's broken file.
 */
export const skippedMessage = (path: string, reason: ReadRefusal): string =>
  `${path} ${REFUSAL_CLAUSE[reason]} — skipped`;

/**
 * Reads a JSON config init is going to rewrite, or refuses.
 *
 * Refusing is the point. A file whose contents cannot be preserved through
 * the merge must not be overwritten — that would silently delete a
 * teammate's, or the user's own, configuration. Three ways a file resists
 * preservation, each refused: it cannot be read, it is not valid JSON, or it
 * is valid JSON that is not an object (an array/string/number cannot carry
 * our merged keys, so writing our object over it is the same clobber as
 * overwriting unparseable bytes). init changes NOTHING and says which file
 * stopped it, and why.
 */
export const readJsonConfig = async (path: string): Promise<ReadJson> => {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return { ok: true, value: {}, raw: null };
  }
  let raw: string;
  try {
    raw = await file.text();
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, reason: "unparseable" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "not-object" };
  }
  return { ok: true, value: parsed as Record<string, unknown>, raw };
};

/** Timestamped backup beside the original, so a bad merge is recoverable. */
export const backUp = async (path: string, raw: string | null): Promise<void> => {
  if (raw !== null) {
    await writeFile(`${path}.bak-${String(Date.now())}`, raw, "utf8");
  }
};

/**
 * Atomic replace: temp sibling + rename, preserving an existing file's mode
 * (the rename would otherwise silently reset a user's chosen permissions).
 * A crash between the two leaves the original untouched — never a torn
 * settings file that Claude Code parses as truth.
 */
export const writeConfigAtomically = async (
  path: string,
  content: string,
): Promise<void> => {
  await ensureDir(dirname(path));
  const existingMode = await stat(path).then(
    (info) => info.mode & 0o777,
    () => null,
  );
  const temp = `${path}.tmp-${String(process.pid)}-${Math.random().toString(36).slice(2, 10)}`;
  await writeFile(temp, content, {
    ...(existingMode === null ? {} : { mode: existingMode }),
  });
  await rename(temp, path);
};

export interface WriteOutcome {
  readonly path: string;
  /** False = the file already held exactly this content; nothing written. */
  readonly wrote: boolean;
}

/**
 * Backup + atomic write, SKIPPED entirely when the rendered content equals
 * what is on disk: the idempotent re-run leaves the file byte-identical
 * AND leaves no fresh backup behind — a second `init --global` is a true
 * no-op, not a growing pile of .bak files.
 */
export const writeIfChanged = async (
  path: string,
  raw: string | null,
  next: string,
): Promise<WriteOutcome> => {
  if (raw === next) {
    return { path, wrote: false };
  }
  await backUp(path, raw);
  await writeConfigAtomically(path, next);
  return { path, wrote: true };
};
