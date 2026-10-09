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
 * an unwritable ledger costs the count, never the hook. A full one first
 * PRUNES the lines the window no longer counts (`prunedToWindow`), and only
 * when every line still counts does it ROTATE (`rotate`) — both review batch
 * 2, M7: past twice the cap inside the window the count is a floor, never a
 * zero.
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

/**
 * A FULL LEDGER ROTATES, IT DOES NOT GO BLIND (review batch 2, M7). Appends
 * used to stop at the cap for good: the lines that filled it aged out of the
 * read window one by one, and `doctor` read 0 for ever after — a storm writes
 * the cap in minutes. At the cap the live file is renamed over the one
 * rotated before it, and appends start a new one; the reader reads both, so
 * the window keeps up to twice the cap and old lines leave with the rotation
 * that replaces them. A rename loses no append racing it — one that opened
 * the old file lands in the rotated one, which is still read — and the
 * rotation runs under the ledger's own lock and checks the size again inside
 * it, so two hooks that both found it full rotate it once, not twice (the
 * second rename would have thrown the first one's lines away).
 */
const rotate = async (path: string): Promise<void> => {
  await withLock(`${path}.lock`, undefined, async () => {
    if ((await sizeOf(path)) >= MAX_BRIEFING_OMISSION_LEDGER_BYTES) {
      await rename(path, rotatedPathOf(path));
    }
  });
};

const parseLine = (line: string): z.infer<typeof LineSchema> | null => {
  try {
    const parsed = LineSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/**
 * AT THE CAP, THE LINES THE WINDOW NO LONGER COUNTS GO (batch-2 review, M7).
 * Appends used to stop at MAX_BRIEFING_OMISSION_LEDGER_BYTES for good, and
 * the reader counts only the last BRIEFING_OMISSION_WINDOW_DAYS — so a full
 * ledger read 0 forever and every new omission went unrecorded. The file is
 * rewritten, under its own lock, with only the lines the reader still counts
 * (an unparseable line counts nothing, and goes too); answers the new size,
 * or the cap itself when the lock is busy — this line is then skipped, as
 * every line used to be. An append racing the rewrite can be lost: rare, and
 * the cap lost all of them before. Like `rotate`, it checks the size again
 * inside the lock: a hook that found the ledger full while another one was
 * already making room — pruning it, or rotating it — finds the room, and
 * rewrites nothing that a third hook may be appending to.
 *
 * It runs BEFORE any rotation: a rotation replaces the file rotated before
 * it, and that file may still hold lines the window counts, so the old lines
 * of the live file go first and the rotation is left for a ledger whose lines
 * all still count (a storm inside the window).
 */
const prunedToWindow = (at: string, now: Date): Promise<number> =>
  withLock(`${at}.lock`, MAX_BRIEFING_OMISSION_LEDGER_BYTES, async () => {
    const size = await sizeOf(at);
    if (size < MAX_BRIEFING_OMISSION_LEDGER_BYTES) {
      return size;
    }
    const windowOpens = now.getTime() - BRIEFING_OMISSION_WINDOW_DAYS * MS_PER_DAY;
    const kept = ((await readTextOrNull(at)) ?? "").split("\n").filter((line) => {
      const entry = line.length === 0 ? null : parseLine(line);
      return entry !== null && Date.parse(entry.at) >= windowOpens;
    });
    const body = kept.map((line) => `${line}\n`).join("");
    await writePrivateFile(at, body);
    return Buffer.byteLength(body);
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
      const size = await sizeOf(at);
      const room = size < MAX_BRIEFING_OMISSION_LEDGER_BYTES ? size : await prunedToWindow(at, entry.now);
      if (room >= MAX_BRIEFING_OMISSION_LEDGER_BYTES) {
        await rotate(at);
      }
      if ((await sizeOf(at)) >= MAX_BRIEFING_OMISSION_LEDGER_BYTES) {
        // Neither the prune nor the rotation could run: the cap holds rather than the file growing.
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
