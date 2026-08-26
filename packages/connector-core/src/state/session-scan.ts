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
 * never ran). `sessionSilentForMs` is what tells those apart.
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
 * How long this session has been SILENT: measured from the newest thing it did
 * — its heartbeat, its start, or the last write to its own state file.
 *
 * THE FILE'S OWN mtime IS PART OF THE ANSWER, and leaving it out was a defect
 * with a name. `lastHeartbeatAt` has exactly two writers in the whole tree
 * (`hooks/post-tool-use.ts` and `flows/register-session.ts`), and PostToolUse
 * returns BEFORE its heartbeat whenever the touch resolved to a DIFFERENT
 * connected repo — the first-wins rule of trial finding #9. So a session whose
 * every edit lands in a foreign checkout books `editToolFires` and
 * `foreignRepoDrops` forever while its heartbeat stays frozen at registration
 * time, and a day later every surface called it dead while its hooks were
 * writing the very file those surfaces were reading. That is the one shape the
 * capture WARN exists to name.
 *
 * Every writer of a state file is one of that session's own hooks
 * (post-tool-use, pre-tool-use, stop, the hint flows, the summarizer worker),
 * so the WRITE is the session speaking. The heartbeat is the subset of those
 * writes that also reaches the hub, and the subset is lossy — which is why the
 * liveness signal is taken from the act rather than from a stamp some path can
 * forget to set.
 *
 * `wroteAtMs` is the file's mtime (`listSessionStateFiles` has already stat'd
 * it); null or 0 means the caller has none, not that the file is from 1970.
 *
 * IT ANSWERS "DID THIS SESSION DO ANYTHING", NEVER "DID IT CAPTURE ANYTHING".
 * An mtime moves for a heartbeat as readily as for a capture, so it can carry
 * liveness and must not be turned into a freshness claim about targets — those
 * have their own stamp (`lastTargetAt`), and a number that is true beats a
 * freshness claim that is nearly true.
 *
 * Null means nothing here can be dated at all. The callers decide what that
 * means, and they do not agree on purpose: a REAPER skips such a file (a
 * deletion has to be certain), while the capture surfaces read it as idle (the
 * only thing that could make it fresh is a clock they cannot read).
 */
export const sessionSilentForMs = (
  state: { readonly lastHeartbeatAt: string | null; readonly startedAt: string },
  wroteAtMs: number | null,
  nowMs: number,
): number | null => {
  const said = Date.parse(state.lastHeartbeatAt ?? state.startedAt);
  const stamps = [
    ...(Number.isNaN(said) ? [] : [said]),
    ...(wroteAtMs === null || wroteAtMs <= 0 ? [] : [wroteAtMs]),
  ];
  return stamps.length === 0 ? null : nowMs - Math.max(...stamps);
};
