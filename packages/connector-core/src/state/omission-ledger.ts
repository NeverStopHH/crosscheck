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
 * a full or unwritable ledger costs the count, never the hook.
 */
import { appendFile, stat } from "node:fs/promises";
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
 * the cap lost all of them before.
 */
const prunedToWindow = (at: string, now: Date): Promise<number> =>
  withLock(`${at}.lock`, MAX_BRIEFING_OMISSION_LEDGER_BYTES, async () => {
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
      const size = await stat(at).then(
        (info) => info.size,
        () => 0,
      );
      const room = size < MAX_BRIEFING_OMISSION_LEDGER_BYTES ? size : await prunedToWindow(at, entry.now);
      if (room >= MAX_BRIEFING_OMISSION_LEDGER_BYTES) {
        return;
      }
      await ensureDir(dirname(at));
      await appendFile(at, `${JSON.stringify({ at: entry.now.toISOString(), reason: entry.reason, key: entry.key })}\n`, "utf8");
    } catch {
      // Fail open: the count is a convenience for doctor, never a failure source.
    }
  };

  const read = async (home: string, key: string, now: Date): Promise<OmissionCounts<R>> => {
    const text = await readTextOrNull(path(home));
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
