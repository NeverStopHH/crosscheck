/**
 * Listing the session-state directory in an order that MEANS something.
 *
 * Three callers used to walk `<home>/sessions` and two of them were wrong in
 * the same way (trial findings M5 and M2): they took `readdir` order — which
 * on bun is neither alphabetical nor chronological — sliced the first N and
 * reduced. On the trial machine that read 50 of 100 files and printed
 * `13 runs (1 NONE, 2 drafts) … across 50 live sessions`, while the full set
 * said 27/3/3; the fires it missed were in files the arbitrary slice never
 * opened, and nothing in the line said "50 of 100".
 *
 * So the order is fixed here, once, for everybody: stat every candidate, sort
 * NEWEST FIRST, then bound. `filesSeen` comes back beside `files` so a caller
 * can say "N of M" instead of implying it read everything.
 *
 * "Live" is the second thing this settles. A state file is deleted at
 * SessionEnd, so its mere existence used to count as a live session — and 75
 * of the trial machine's 100 files belonged to sessions killed hours or days
 * earlier (closed terminals, killed orchestration agents, SessionEnds that
 * never ran). `heartbeatAgeMs` is what tells those apart, from the heartbeat
 * when there is one and from `startedAt` when there is not: a file whose
 * session never heartbeated at all is exactly as dead as one that stopped.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const STATE_SUFFIX = ".json";

export interface SessionStateFile {
  readonly name: string;
  readonly path: string;
  readonly mtimeMs: number;
}

export interface SessionStateListing {
  /** Bounded, newest-modified first. */
  readonly files: readonly SessionStateFile[];
  /** How many candidates existed — `files.length` is what was read. */
  readonly filesSeen: number;
}

const EMPTY_LISTING: SessionStateListing = { files: [], filesSeen: 0 };

export const sessionStateDir = (home: string): string => join(home, "sessions");

/**
 * One `readdir` plus one `stat` per candidate, then the sort and the bound.
 *
 * The stats are what the bound cannot come before: sorting by mtime requires
 * knowing every candidate's mtime, so a home with a thousand stale files pays
 * a thousand stats here where it used to pay fifty reads. A stat is far
 * cheaper than the `readJsonOrNull` the caller would have done, the callers
 * are human-run surfaces (`status`, `doctor`) and one SessionStart's
 * maintenance region, and the alternative is the arbitrary-subset defect
 * above. A file that vanishes between the readdir and its stat is dropped
 * rather than guessed at.
 */
export const listSessionStateFiles = async (
  home: string,
  limit: number,
): Promise<SessionStateListing> => {
  const dir = sessionStateDir(home);
  let names: readonly string[];
  try {
    names = await readdir(dir);
  } catch {
    return EMPTY_LISTING;
  }
  const candidates = names.filter((name) => name.endsWith(STATE_SUFFIX));
  const stated = await Promise.all(
    candidates.map(async (name): Promise<SessionStateFile | null> => {
      const path = join(dir, name);
      try {
        return { name, path, mtimeMs: (await stat(path)).mtimeMs };
      } catch {
        return null;
      }
    }),
  );
  const files = stated
    .filter((entry): entry is SessionStateFile => entry !== null)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, limit);
  return { files, filesSeen: candidates.length };
};

/**
 * How long since this session last said anything — the heartbeat when it has
 * one, the start otherwise.
 *
 * Null means neither timestamp can be read, which the callers treat as "not
 * stale": a state file nobody can date is not evidence of a dead session, and
 * a reaper or a WARN built on a guess is worse than one that skips a file.
 */
export const heartbeatAgeMs = (
  state: { readonly lastHeartbeatAt: string | null; readonly startedAt: string },
  nowMs: number,
): number | null => {
  const iso = state.lastHeartbeatAt ?? state.startedAt;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : nowMs - ms;
};
