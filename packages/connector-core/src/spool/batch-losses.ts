/**
 * WHAT ONE BATCH HAS LOST WHATEVER COMES NEXT — torn lines, withheld
 * stragglers, and the refusals no heal can carry — written to the drop ledger
 * ONCE PER LINE (review-2 finding 4).
 *
 * These are written before a heal's walk registers the next life, so that
 * register already reports them (review P3). A walk can leave the batch on
 * disk — no life registered and another conversation's records at stake, no
 * room left to re-send — and the next walk meets the same lines again. Every
 * walk used to write them again: one torn line and one straggler read as three
 * of each after three cooldowns, and flowed into the hub's `loss_total` for
 * as long as the batch waited, up to the spool's age bound. What was written
 * is now noted on the cursor (spool/cursor.ts readCountedLines), and only
 * lines not on that note are written — one line, one loss.
 */
import type { HubContext } from "../http/client.ts";
import { writeCountedLines } from "./cursor.ts";
import { recordDrop } from "./drops.ts";
import type { SessionSpool } from "./files.ts";
import { kindsOf } from "./flush-heal.ts";

/** One line of the batch: what it parsed to (null when torn), and where it ends in the file. */
export interface BatchLine {
  readonly record: Record<string, unknown> | null;
  readonly end: number;
}

/** A line that parsed — every line the batch can send. */
export interface SpooledLine extends BatchLine {
  readonly record: Record<string, unknown>;
}

/**
 * WITHHELD, NOT SENT: records a refused life produced whose body names that
 * life (spool/flush-heal.ts). Counted under their own reason, `withheld` —
 * nothing was sent, so "rejected by the hub" would be false — with the cause
 * the hub gave for their life: it already ended it, and any live session's
 * delivery would file them into it past its end.
 */
const recordWithheld = async (
  ctx: HubContext,
  spool: SessionSpool,
  withheld: readonly Record<string, unknown>[],
): Promise<void> => {
  if (withheld.length > 0) {
    await recordDrop(ctx.home, ctx.repoKey, spool.slug, withheld.length, "withheld", ctx.now(), kindsOf(withheld), {
      session_ended: withheld.length,
    });
  }
};

/** The refusals no heal can carry: the hub's answer for them, `session_ended`. */
const recordSealed = async (
  ctx: HubContext,
  spool: SessionSpool,
  sealed: readonly Record<string, unknown>[],
): Promise<void> => {
  if (sealed.length > 0) {
    await recordDrop(ctx.home, ctx.repoKey, spool.slug, sealed.length, "rejected", ctx.now(), kindsOf(sealed), {
      session_ended: sealed.length,
    });
  }
};

const withEnds = (ends: ReadonlySet<number>, lines: readonly BatchLine[]): ReadonlySet<number> =>
  new Set([...ends, ...lines.map((line) => line.end)]);

export interface BatchLosses {
  /**
   * Writes what this batch has certainly lost and no earlier walk wrote down.
   * Runs once, however many paths ask; `sealed` indexes the sendable lines.
   */
  readonly write: (sealed: readonly number[]) => Promise<void>;
  /** Notes what was written on the cursor, for a batch that stays on disk. */
  readonly keep: () => Promise<void>;
}

export const batchLosses = (
  ctx: HubContext,
  spool: SessionSpool,
  lines: readonly BatchLine[],
  sendable: readonly SpooledLine[],
  isWithheld: (record: Record<string, unknown>) => boolean,
  earlier: ReadonlySet<number>,
): BatchLosses => {
  let written = earlier;
  let running: Promise<void> | null = null;
  const isNew = (line: BatchLine): boolean => !earlier.has(line.end);
  const run = async (sealed: readonly number[]): Promise<void> => {
    const torn = lines.filter((line) => line.record === null && isNew(line));
    const withheld = lines.filter(
      (line): line is SpooledLine => line.record !== null && isWithheld(line.record) && isNew(line),
    );
    const refused = sealed
      .map((index) => sendable[index])
      .filter((line): line is SpooledLine => line !== undefined && isNew(line));
    await recordDrop(ctx.home, ctx.repoKey, spool.slug, torn.length, "unparsable", ctx.now());
    await recordWithheld(ctx, spool, withheld.map((line) => line.record));
    await recordSealed(ctx, spool, refused.map((line) => line.record));
    written = withEnds(earlier, [...torn, ...withheld, ...refused]);
  };
  return {
    write: (sealed) => {
      running ??= run(sealed);
      return running;
    },
    keep: async () => {
      if (running !== null) {
        await running;
        await writeCountedLines(spool.dataPath, spool.cursorPath, spool.offset, written, spool);
      }
    },
  };
};
