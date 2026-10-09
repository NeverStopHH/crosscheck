/**
 * ONE SHAPE FOR EVERY "THE PERSON WAS NOT TOLD" LEDGER (2026-10-08): a local,
 * append-only, bounded file of `{ at, reason, key }` lines that `doctor` and
 * `status` count over BRIEFING_OMISSION_WINDOW_DAYS. Two instances:
 *
 *   state/briefing-omissions.ts   a SessionStart briefing that did not arrive
 *                                 whole (the budget, a fault, hub reads);
 *   state/landed-probe-cuts.ts    a PreToolUse landed-change check cut short
 *                                 before it could answer.
 *
 * LOCAL, NEVER ON THE WIRE: none of these loses a record, so none is a new
 * loss kind every hub would have to validate. One machine-wide file per
 * ledger, keyed per line like the capture-loss ledger (state/loss-ledger.ts):
 * a hook that never learned its repo writes a null key, and the reader
 * charges it to every repo — the conservative reading. Fail open throughout:
 * an unwritable ledger costs the count, never the hook. A full one MAKES ROOM
 * (`makeRoom`, review batch 2, M7): it first prunes the lines the window no
 * longer counts, and only when every line still counts does it rotate — past
 * twice the cap inside the window the count is a floor, never a zero.
 */
import { appendFile, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import { BRIEFING_OMISSION_WINDOW_DAYS, MAX_BRIEFING_OMISSION_LEDGER_BYTES } from "../constants.ts";
import { ensureDir, readTextOrNull, writePrivateFile } from "../config/paths.ts";
import { withLock } from "../spool/lock.ts";

const MS_PER_DAY = 86_400_000;

export interface OmissionEntry<R extends string> {
  /** The repo key, or null when the hook never learned it (charged to every repo). */
  readonly key: string | null;
  readonly reason: R;
  readonly now: Date;
}

export interface OmissionCounts<R extends string> {
  readonly total: number;
  readonly byReason: Readonly<Record<R, number>>;
  /** The newest line's instant, or null when there is none in the window. */
  readonly lastAt: string | null;
}

export interface OmissionLedger<R extends string> {
  readonly path: (home: string) => string;
  readonly record: (home: string, entry: OmissionEntry<R>) => Promise<void>;
  /**
   * This repo's lines inside BRIEFING_OMISSION_WINDOW_DAYS: its own key's
   * and the unkeyed ones. A line that will not parse, names a reason this
   * ledger does not know, or carries no readable instant is skipped — the
   * ledger is a count, not evidence.
   */
  readonly read: (home: string, key: string, now: Date) => Promise<OmissionCounts<R>>;
}

const LineSchema = z.looseObject({
  at: z.string().min(1),
  reason: z.string().min(1),
  key: z.string().nullable().catch(null),
});

const sizeOf = (path: string): Promise<number> =>
  stat(path).then(
    (info) => info.size,
    () => 0,
  );

/** Where a full ledger's lines go, read beside the live file until the next rotation replaces them. */
export const rotatedPathOf = (path: string): string => `${path}.1`;

const parseLine = (line: string): z.infer<typeof LineSchema> | null => {
  try {
    const parsed = LineSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/** Rewrites `at` with only the lines the reader still counts (an unparseable line counts nothing, and goes too); answers the new size. */
const prunedToWindow = async (at: string, now: Date): Promise<number> => {
  const windowOpens = now.getTime() - BRIEFING_OMISSION_WINDOW_DAYS * MS_PER_DAY;
  const kept = ((await readTextOrNull(at)) ?? "").split("\n").filter((line) => {
    const entry = line.length === 0 ? null : parseLine(line);
    return entry !== null && Date.parse(entry.at) >= windowOpens;
  });
  const body = kept.map((line) => `${line}\n`).join("");
  await writePrivateFile(at, body);
  return Buffer.byteLength(body);
};

/**
 * A FULL LEDGER MAKES ROOM, IT DOES NOT GO BLIND (review batch 2, M7 — both
 * tracks' fixes, as one step). Appends used to stop at the cap for good, and
 * the reader counts only the last BRIEFING_OMISSION_WINDOW_DAYS: the lines
 * that filled the file aged out one by one and `doctor` read 0 for ever after,
 * while a storm writes the cap in minutes. Under ONE hold of the ledger's own
 * lock, on the size it finds there:
 *
 *   1. room already: another hook made it while this one waited, and the
 *      ledger is left as it is — nothing rewritten under a third hook's
 *      append;
 *   2. otherwise the lines the window no longer counts go (track B). FIRST,
 *      because a rotation replaces the file rotated before it, which may
 *      still hold lines the window counts;
 *   3. and only when the prune left no room — every line still counts, a
 *      storm inside the window — the live file is renamed over the rotated
 *      one, and appends start a new one (track A). The reader reads both, so
 *      the window keeps up to twice the cap.
 *
 * One hold, so no hook can rotate a file another hook already rotated (the
 * second rename would throw the first one's lines away): the rename happens
 * only in the hold that found the file still full after its own prune. A
 * rename loses no append racing it — one that opened the old file lands in
 * the rotated one, which is still read; an append racing the prune's rewrite
 * can be lost — rare, and the cap lost all of them before. A busy lock makes
 * no room, and the caller skips its line, as every line used to be skipped.
 * Exported for its race test.
 */
export const makeRoom = (at: string, now: Date): Promise<void> =>
  withLock(`${at}.lock`, undefined, async () => {
    if ((await sizeOf(at)) < MAX_BRIEFING_OMISSION_LEDGER_BYTES) {
      return;
    }
    if ((await prunedToWindow(at, now)) >= MAX_BRIEFING_OMISSION_LEDGER_BYTES) {
      await rename(at, rotatedPathOf(at));
    }
  });

export const omissionLedger = <R extends string>(file: string, reasons: readonly R[]): OmissionLedger<R> => {
  const path = (home: string): string => join(home, "state", file);
  const none: OmissionCounts<R> = {
    total: 0,
    byReason: Object.fromEntries(reasons.map((reason) => [reason, 0])) as Record<R, number>,
    lastAt: null,
  };
  const isReason = (value: string): value is R => (reasons as readonly string[]).includes(value);

  const record = async (home: string, entry: OmissionEntry<R>): Promise<void> => {
    try {
      const at = path(home);
      if ((await sizeOf(at)) >= MAX_BRIEFING_OMISSION_LEDGER_BYTES) {
        await makeRoom(at, entry.now);
      }
      if ((await sizeOf(at)) >= MAX_BRIEFING_OMISSION_LEDGER_BYTES) {
        // No room could be made (a busy lock): the cap holds rather than the file growing.
        return;
      }
      await ensureDir(dirname(at));
      await appendFile(at, `${JSON.stringify({ at: entry.now.toISOString(), reason: entry.reason, key: entry.key })}\n`, "utf8");
    } catch {
      // Fail open: the count is a convenience for doctor, never a failure source.
    }
  };

  const read = async (home: string, key: string, now: Date): Promise<OmissionCounts<R>> => {
    const [rotated, current] = await Promise.all([readTextOrNull(rotatedPathOf(path(home))), readTextOrNull(path(home))]);
    const text = rotated === null && current === null ? null : `${rotated ?? ""}\n${current ?? ""}`;
    if (text === null) {
      return none;
    }
    const since = now.getTime() - BRIEFING_OMISSION_WINDOW_DAYS * MS_PER_DAY;
    return text
      .split("\n")
      .flatMap((line) => {
        const entry = line.length === 0 ? null : parseLine(line);
        const at = entry === null ? Number.NaN : Date.parse(entry.at);
        return entry !== null &&
          isReason(entry.reason) &&
          (entry.key === null || entry.key === key) &&
          at >= since &&
          at <= now.getTime()
          ? [{ reason: entry.reason, at }]
          : [];
      })
      .reduce<OmissionCounts<R>>(
        (counts, entry) => ({
          total: counts.total + 1,
          byReason: { ...counts.byReason, [entry.reason]: counts.byReason[entry.reason] + 1 },
          lastAt:
            counts.lastAt === null || entry.at > Date.parse(counts.lastAt) ? new Date(entry.at).toISOString() : counts.lastAt,
        }),
        none,
      );
  };

  return { path, record, read };
};
