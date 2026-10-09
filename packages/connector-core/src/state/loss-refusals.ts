/**
 * WHAT THE CAPTURE-LOSS LEDGER REFUSED (review H1, docs/1.0/loss-accounting.md
 * §4.3). The ledger is machine-wide and capped at MAX_LOSS_LEDGER_BYTES; once
 * other repos filled it, a hook that timed out in THIS repo was refused with
 * no trace, the repo reported `{total: 0}` and the hub read `complete`.
 *
 * So the ledger keeps one small marker beside it, written two ways:
 *   - by the append that FILLS the ledger: `fullSince`, the instant the
 *     ledger stopped taking detail;
 *   - by every REFUSED append: the refused count per kind and the newest
 *     refusal's instant.
 * The reader charges the refused losses to EVERY repo — which repo lost them
 * is exactly the detail the cap refused, and over-charging only weakens — and
 * takes `newestAt` as the newest loss, so a full ledger ages out of the hub's
 * window fourteen days after its last refusal instead of freezing.
 *
 * A whole-file write through `writePrivateFile`, like `unrecorded.dropmarker`
 * (spool/drops.ts), and a read-modify-write under the marker's own lock
 * (review batch 2, M9): racing hooks take turns. Only a lock that stays busy
 * past its patience can still lose an increment, never the marker, so its
 * counts stay FLOORS and the reader says so. A marker that will not parse reads as absent, and an absent marker
 * beside a full ledger makes the reader's newest unknown (spool/loss-report.ts).
 */
import { dirname, join } from "node:path";
import { z } from "zod";

import { UNATTRIBUTED_LOSS_KIND } from "@crosscheck/schema";

import { SESSION_STATE_LOCK_RETRIES } from "../constants.ts";
import { ensureDir, writePrivateFile } from "../config/paths.ts";
import { addCount } from "../spool/counts.ts";
import { withLock } from "../spool/lock.ts";
import type { Counts } from "../spool/counts.ts";
import { ledgerInstant, readLedgerText } from "../spool/ledger-read.ts";

const REFUSALS_FILE = "losses.refused.json";

export const lossRefusalsPath = (home: string): string =>
  join(home, "state", REFUSALS_FILE);

const RefusalsSchema = z.looseObject({
  fullSince: z.string().min(1),
  newestAt: z.string().min(1),
  refused: z.record(z.string(), z.number().int().min(0)),
});

export interface LossRefusals {
  /** When the ledger stopped taking lines. */
  readonly fullSince: string;
  /** The newest refusal, or `fullSince` when none has happened yet. */
  readonly newestAt: string;
  /** Refused losses per capture kind — floors. */
  readonly refused: Counts;
}

/**
 * A marker that exists and cannot be read or parsed (review M1) still says
 * the ledger refused something: one loss of unknown kind, dated by the
 * marker's mtime. With no mtime either there is nothing to date it by, and
 * the reader's full-ledger rule makes the newest unknown instead.
 */
const unreadableRefusals = (writtenBy: string | null): LossRefusals | null =>
  writtenBy === null
    ? null
    : { fullSince: writtenBy, newestAt: writtenBy, refused: { [UNATTRIBUTED_LOSS_KIND]: 1 } };

export const readLossRefusals = async (home: string): Promise<LossRefusals | null> => {
  const { text, writtenBy, unreadable } = await readLedgerText(lossRefusalsPath(home));
  if (text === null && !unreadable) {
    return null;
  }
  const parsed = RefusalsSchema.safeParse(safeJson(text ?? ""));
  if (!parsed.success) {
    return unreadableRefusals(writtenBy);
  }
  const fullSince = ledgerInstant(parsed.data.fullSince);
  const newestAt = ledgerInstant(parsed.data.newestAt);
  return fullSince === null || newestAt === null
    ? unreadableRefusals(writtenBy)
    : { fullSince, newestAt, refused: parsed.data.refused };
};

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

const writeRefusals = async (home: string, refusals: LossRefusals): Promise<void> => {
  const path = lossRefusalsPath(home);
  await ensureDir(dirname(path));
  await writePrivateFile(path, `${JSON.stringify(refusals)}\n`);
};

const later = (left: string, right: string): string => (right > left ? right : left);

/**
 * ONE WRITER AT A TIME (review batch 2, M9). Both writes below read the marker,
 * change it and write it back whole, and twelve hooks refused at once used to
 * leave a count of 1, once 2: every writer read the marker before any wrote
 * it. Under the marker's own lock they take turns — with the state lock's
 * patience, enough for a dozen at once — and a lock that stays busy past it
 * still writes, unlocked, as before: a count that may lose an increment, never
 * a refusal with no trace.
 */
const underRefusalsLock = async (home: string, write: () => Promise<void>): Promise<void> => {
  const isWritten = await withLock(
    `${lossRefusalsPath(home)}.lock`,
    false,
    async () => {
      await write();
      return true;
    },
    SESSION_STATE_LOCK_RETRIES,
  );
  if (!isWritten) {
    await write();
  }
};

/** The append that filled the ledger: the instant detail stopped, once. */
export const markLossLedgerFull = async (home: string, now: Date): Promise<void> => {
  await underRefusalsLock(home, async () => {
    if ((await readLossRefusals(home)) !== null) {
      return;
    }
    const at = now.toISOString();
    await writeRefusals(home, { fullSince: at, newestAt: at, refused: {} });
  });
};

/** One refused append: counted per kind, dated, charged by the reader to every repo. */
export const recordRefusedLoss = async (
  home: string,
  kind: string,
  count: number,
  now: Date,
): Promise<void> => {
  await underRefusalsLock(home, async () => {
    const prior = await readLossRefusals(home);
    const at = now.toISOString();
    await writeRefusals(home, {
      fullSince: prior?.fullSince ?? at,
      newestAt: prior === null ? at : later(prior.newestAt, at),
      refused: addCount(prior?.refused ?? {}, kind, count),
    });
  });
};
