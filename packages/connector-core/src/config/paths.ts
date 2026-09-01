import { chmod, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  HOME_DIR_MODE,
  PRIVATE_FILE_MODE,
  REPO_KEY_CHARS,
} from "../constants.ts";

export type Env = Readonly<Record<string, string | undefined>>;

export const crosscheckHome = (env: Env): string =>
  env["CROSSCHECK_HOME"] ?? join(homedir(), ".crosscheck");

/**
 * Path-safe and hub-scoped: the same repo on two hubs never shares a spool,
 * and no repo name ever reaches the filesystem.
 */
export const repoKey = (hubUrl: string, repoId: string): string =>
  new Bun.CryptoHasher("sha256")
    .update(`${hubUrl}\n${repoId}`)
    .digest("hex")
    .slice(0, REPO_KEY_CHARS);

export const configPath = (home: string): string => join(home, "config.json");

/**
 * Where the Tier-1 summarizer's nested `claude -p` runs FROM (trial finding
 * #14): a neutral directory under the crosscheck home, never the repo root
 * the Stop hook fired in. A claude started in a repo loads that repo's
 * CLAUDE.md and rules into every fire — tokens on the developer's own quota
 * and a prompt biased by project instructions the summarizer prompt never
 * asked for. Created 0700 by the worker (summarizer/worker.ts) like every
 * other directory under the home.
 */
export const summarizerCwdPath = (home: string): string =>
  join(home, "summarizer-cwd");

/**
 * The one encoding of a session id into a filename. A spool data file and the
 * session state file that proves its writer is alive MUST derive their names
 * from this single function — `reap` decides whether it may delete a spool file
 * by looking up the state file of the same slug, and that lookup is only sound
 * while the two namings cannot drift apart.
 *
 * VERIFY: grep -c "sessionSlu[g]" packages/connector-core/src/config/paths.ts
 * PRINTS: 2
 * (this definition, and the single application in `sessionStatePath`; every
 * other path takes an already-derived `slug`, which is what stops the two
 * namings drifting. The bracket keeps this line from counting itself.)
 *
 * CASE. `encodeURIComponent` preserves case, so this is injective over session
 * ids — but the FILESYSTEM need not be. On a case-insensitive one (APFS by
 * default, so most developer Macs) two session ids differing only in case give
 * two distinct slugs that name ONE file. Measured on macOS APFS: both sessions'
 * records land in a single `.jsonl`, `listSessionSlugs` reports only the
 * creator's casing, and — the severe part — the two session STATE files collide
 * too, because they come from this same function. One session ending then
 * deletes the other's state, and `isSessionLive` (reap.ts) answers false for a
 * session that is still running, which retires reap's first guard. On a
 * case-sensitive filesystem (Linux, case-sensitive HFS+) none of it happens.
 *
 * It is deliberately NOT fixed, because no producer is established: nothing
 * shows Claude Code can emit two session ids differing only in case, and UUIDs
 * are conventionally lowercase. What would make it real is one session id whose
 * casing varies between hooks — look here first if that ever shows up.
 *
 * If it does, `toLowerCase()` is the wrong move: it COLLAPSES the two ids on
 * purpose, which is the collision itself. It needs a case-free encoding or a
 * short hash suffix of the raw id, and it needs a migration — changing this
 * function orphans every spool already on disk, and an orphaned spool is not
 * inert: it ages out through MAX_SPOOL_AGE_DAYS counted as `expired`, which is
 * real record loss. Reading both names through a transition is the cheap way.
 */
export const sessionSlug = (hostSessionKey: string): string =>
  encodeURIComponent(hostSessionKey);

export const sessionStatePathForSlug = (home: string, slug: string): string =>
  join(home, "sessions", `${slug}.json`);

/**
 * Where the UserPromptSubmit hook parks the FIRST substantive prompt for the
 * detached derived-intent worker (core derive/intent/worker.ts) — a 0600
 * file beside the session state, never argv (visible in `ps`) and never
 * stdin (the hook exits before a detached child could read it). The worker
 * unlinks it in `finally`; `endSessionFlow` removes a leftover best-effort.
 * Takes the derived slug like every other per-session path here.
 */
export const intentPromptPathForSlug = (home: string, slug: string): string =>
  join(home, "sessions", `${slug}.intent-prompt`);

export const sessionStatePath = (
  home: string,
  hostSessionKey: string,
): string => sessionStatePathForSlug(home, sessionSlug(hostSessionKey));

/** One directory per repo, one data file per session inside it. */
export const spoolDir = (home: string, key: string): string =>
  join(home, "spool", key);

/**
 * Append-only, never renamed, never truncated, never rewritten. Its own
 * session's hooks are the normal writer, not the only one: reap's `rescueTail`
 * and write.ts's orphan re-append also append to a file they do not own
 * (spool/append.ts spells both out). Deleted only by `reap`, and only once no
 * session state claims it — which is necessary but not sufficient (a
 * PostToolUse can still append after SessionEnd removed the state), so the
 * append path checks `nlink` after its write and recovers from the unlink it
 * lost (write.ts).
 */
export const spoolDataPath = (
  home: string,
  key: string,
  slug: string,
): string => join(spoolDir(home, key), `${slug}.jsonl`);

/**
 * How far the hub has acknowledged. Nothing ever appends to a cursor file, so
 * replacing it atomically is safe in a way replacing a data file is not.
 */
export const spoolCursorPath = (
  home: string,
  key: string,
  slug: string,
): string => join(spoolDir(home, key), `${slug}.cursor`);

/**
 * An end the hub has NOT been told about yet, because the session's own records
 * had not all reached it when SessionEnd ran. Holds the crosscheck session id,
 * which is the one thing `reap` cannot derive once the state file is gone —
 * SessionStart's conflict retry can append a suffix to it — and the time the
 * deferral was made, which is what MAX_SPOOL_AGE_DAYS is measured against.
 *
 * The suffix keeps it out of the `.jsonl` and `.drops` listings that reap walks.
 */
export const spoolPendingEndPath = (
  home: string,
  key: string,
  slug: string,
): string => join(spoolDir(home, key), `${slug}.pending-end`);

/** Append-only ledger of dropped batches: the source of truth for `spoolDropped`. */
export const spoolDropsPath = (
  home: string,
  key: string,
  slug: string,
): string => join(spoolDir(home, key), `${slug}.drops`);

/**
 * Where the age sweep folds the TOTAL of a ledger it removes, so the number
 * outlives the per-batch detail. One line, rewritten in place, per repo.
 *
 * The `.dropsummary` suffix keeps it out of the `.drops` listing that the sweep
 * itself walks — an aggregate the sweep could reach would eventually delete the
 * very number it exists to preserve. A session slug is `encodeURIComponent` of
 * a session id, so no slug-derived name can collide with this one.
 */
export const spoolDropsArchivePath = (home: string, key: string): string =>
  join(spoolDir(home, key), "archive.dropsummary");

/**
 * Where a drop goes when the append to its own ledger did not land WHOLE —
 * nothing written, or only a torn fragment — so the failure of the ledger stays
 * visible even though the count never reached a countable line. One line,
 * rewritten in place, per repo (drops.ts).
 *
 * The `.dropmarker` suffix keeps it out of both listings the sweep walks — the
 * `.drops` ledgers and the `.jsonl` data files — for the same reason
 * `.dropsummary` stays out of the first. A session slug is
 * `encodeURIComponent` of a session id and every slug-derived name in this
 * directory carries a slug suffix, so no slug can produce this name.
 */
export const spoolUnrecordedDropsPath = (home: string, key: string): string =>
  join(spoolDir(home, key), "unrecorded.dropmarker");

/**
 * Where the age sweep counts a `.pending-end` marker it retires, so the fact
 * that a session was never closed outlives the marker. One line, rewritten in
 * place, per repo.
 *
 * The `.endsummary` suffix keeps it out of the `.pending-end` listing the sweep
 * itself walks, for the same reason `.dropsummary` stays out of the `.drops`
 * one. A session slug is `encodeURIComponent` of a session id, and every
 * slug-derived name in this directory carries a slug suffix, so no slug can
 * produce this name.
 */
export const spoolUnclosedPath = (home: string, key: string): string =>
  join(spoolDir(home, key), "unclosed.endsummary");

/**
 * Guards flush and reap only. Appends never take it, so a lock that is busy or
 * stale costs a deferred flush — never a record.
 */
export const spoolFlushLockPath = (home: string, key: string): string =>
  join(spoolDir(home, key), "flush.lock");

export const syncStatePath = (home: string, key: string): string =>
  join(home, "state", `${key}.json`);

/**
 * Per-repo delivered-hint hashes (hints/delivered-store.ts): truncated
 * SHA-256 of normalized bodies, never the bodies. The `-delivered-hints`
 * suffix cannot collide with syncStatePath — repo keys are bare hex.
 */
export const deliveredHintsPath = (home: string, key: string): string =>
  join(home, "state", `${key}-delivered-hints.json`);

export const presenceCachePath = (home: string, key: string): string =>
  join(home, "cache", `${key}-presence.json`);

/**
 * Where `crosscheck conference` leaves its reports (VISION.md §2). Under the
 * crosscheck home rather than in the repo: a report quotes teammates' claims,
 * so it is private-file material like every other state file here, and a
 * document that appears in `git status` after a command that promised to
 * change nothing is a surprise nobody asked for.
 *
 * Reports are NOT reaped. They are the artifact the command exists to
 * produce, and deleting a page a human may not have read yet to save a few
 * kilobytes is not a trade this project makes silently.
 */
export const conferenceDir = (home: string, key: string): string =>
  join(home, "conferences", key);

/**
 * One report, named by the run's own UTC SECOND — stable and sortable, and
 * with a `-2`, `-3` suffix from the caller when two runs land on the same one
 * (cli/conference.ts freeReportPath). It was the MINUTE, which meant a
 * scheduler retrying after a transient hub error silently replaced the page it
 * had just written while printing both paths as if both existed.
 *
 * Past that caller's bound of suffixes there is no free name left, and the run
 * REFUSES to write rather than take one back — the never-reaped guarantee
 * above holds all the way to the edge of the second, or it is not a guarantee.
 */
export const conferenceReportPath = (
  home: string,
  key: string,
  stamp: string,
): string => join(conferenceDir(home, key), `conference-${stamp}.md`);

/** The counters `crosscheck status` and `doctor` read for this repo+hub. */
export const conferenceCostPath = (home: string, key: string): string =>
  join(home, "state", `${key}-conference.json`);

/** Its lock: two conferences at once must not lose a count between them. */
export const conferenceCostLockPath = (home: string, key: string): string =>
  `${conferenceCostPath(home, key)}.lock`;
/**
 * Per-repo record of which HOOK EVENTS have actually fired, and when
 * (state/fired-markers.ts). Trial finding M2: every hook check in `doctor`
 * was textual — it read the settings file and reported what it SAID, so a
 * PATH that no longer resolves, a `CROSSCHECK_DISABLED`, or an agent started
 * before the wiring all read PASS. Nothing on this machine recorded a hook
 * having run. The `-hooks` suffix cannot collide with `syncStatePath` — repo
 * keys are bare hex.
 */
export const hooksFiredPath = (home: string, key: string): string =>
  join(home, "state", `${key}-hooks.json`);

/**
 * Per-repo record of the last time the STATUSLINE actually rendered (trial
 * finding H7). `statusline registered` is a textual check too, and the
 * statusline is a terminal-TUI feature: in headless and VS Code–extension
 * sessions Claude Code never calls it, so "registered" and "rendered" are
 * different facts and only one of them was ever printed.
 */
export const statuslineFiredPath = (home: string, key: string): string =>
  join(home, "state", `${key}-statusline.json`);

export const ensureDir = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true, mode: HOME_DIR_MODE });
};

const tempSibling = (path: string): string =>
  `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Atomic write: a crashed hook must never leave a half-written state file that
 * the next hook parses as truth.
 */
export const writePrivateFile = async (
  path: string,
  content: string,
): Promise<void> => {
  await ensureDir(dirname(path));
  const temp = tempSibling(path);
  await writeFile(temp, content, { mode: PRIVATE_FILE_MODE });
  await chmod(temp, PRIVATE_FILE_MODE);
  await rename(temp, path);
};

export const readTextOrNull = async (path: string): Promise<string | null> => {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      return null;
    }
    return await file.text();
  } catch {
    return null;
  }
};

export const readJsonOrNull = async (path: string): Promise<unknown> => {
  const text = await readTextOrNull(path);
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

export const removeFile = async (path: string): Promise<void> => {
  try {
    await rm(path, { force: true });
  } catch {
    // Deleting state is best-effort; a stale file is harmless.
  }
};
/** Deepest existing ancestor is resolved, remaining segments re-appended. */
const MAX_REALPATH_WALK = 64;

/**
 * Symlinked temp roots (/var vs /private/var on macOS) otherwise make a file
 * inside the repo look like it lives outside it.
 */
export const realpathBestEffort = async (path: string): Promise<string> => {
  const suffix: string[] = [];
  let current = path;
  for (let depth = 0; depth < MAX_REALPATH_WALK; depth += 1) {
    try {
      const resolved = await realpath(current);
      return suffix.length === 0
        ? resolved
        : join(resolved, ...[...suffix].reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        return path;
      }
      suffix.push(basename(current));
      current = parent;
    }
  }
  return path;
};
