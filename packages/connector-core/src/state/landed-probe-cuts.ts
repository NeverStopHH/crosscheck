/**
 * LANDED-CHANGE CHECKS CUT SHORT (2026-10-08), counted — the briefing
 * omission's sibling, in the same shape (state/omission-ledger.ts).
 *
 * The PreToolUse stop asks the reader's own clone whether a teammate's change
 * to the file has landed and is missing (landed-changes/probe.ts). Under load
 * the probe's deadline ended it, or a landing branch's git could not answer,
 * before it knew — and the hook then stopped nothing and recorded nothing:
 * the reader edited a file a teammate had already changed on main, and
 * nothing said a check had not finished. Each such check now books one line
 * here and bumps a per-session counter (state/session-state.ts
 * landedProbeCuts); the session is told ONCE, at its next prompt, and
 * `doctor` and `status` count the lines over the window. The edit itself
 * stays quiet — a line per edit would be the noise the stop's once-per-file
 * rule exists to prevent.
 *
 *   deadline     the probe's deadline ended it before it knew
 *   unanswered   it finished, with a landing branch git could not answer for
 *   budget       the whole pre-edit hook ran out of its budget first, and
 *                the runner abandoned it, the check with it — measured at a
 *                load average near 90, where the steps BEFORE the probe
 *                already took most of the race
 */
import { omissionLedger } from "./omission-ledger.ts";
import type { OmissionCounts, OmissionEntry } from "./omission-ledger.ts";
import { updateSessionState, withLandedProbeCut } from "./session-state.ts";

export const LANDED_PROBE_CUT_REASONS = ["deadline", "unanswered", "budget"] as const;

export type LandedProbeCutReason = (typeof LANDED_PROBE_CUT_REASONS)[number];

const LEDGER = omissionLedger("landed-probe-cuts.jsonl", LANDED_PROBE_CUT_REASONS);

export const landedProbeCutsPath = LEDGER.path;

export type LandedProbeCut = OmissionEntry<LandedProbeCutReason>;

export type LandedProbeCutCounts = OmissionCounts<LandedProbeCutReason>;

export const recordLandedProbeCut = LEDGER.record;

export const readLandedProbeCuts = LEDGER.read;

export interface LandedProbeCutBooking {
  readonly home: string;
  readonly sessionId: string;
  /** The host's id for the edit's tool call; null books per session. */
  readonly toolUseId: string | null;
  /** The repo the cut is charged to; null charges every repo (the ledger's rule). */
  readonly key: string | null;
  readonly reason: LandedProbeCutReason;
  readonly now: Date;
}

/**
 * The tool calls this PROCESS has booked a cut for, each with its booking
 * still in flight or done. Two writers can see one cut — the pre-edit handler
 * when its probe came back cut, and the runner when the budget abandoned the
 * handler — and a handler the race abandoned keeps running until the process
 * exits, so without this a cut booked by the handler a moment before the race
 * resolved would be booked again by the runner. One hook process handles one
 * tool call, so the map stays at most one entry; it is module state on
 * purpose, the one thing both writers share.
 */
const booked = new Map<string, Promise<void>>();

/** The cut's two writes: the session's counter, then the ledger line. */
const writeCut = async (booking: LandedProbeCutBooking): Promise<void> => {
  await updateSessionState(booking.home, booking.sessionId, withLandedProbeCut);
  await recordLandedProbeCut(booking.home, { key: booking.key, reason: booking.reason, now: booking.now });
};

/**
 * ONE cut, booked in both places it is read from — the session's counter
 * (its next prompt tells it once) and the ledger `doctor` and `status`
 * count — at most once per tool call. Marked before the first write, so the
 * second writer stops at the mark however the two interleave — and WAITS
 * there for the first writer's writes (review batch 2, L6): the runner books
 * after the race and the binary exits the moment it returns, so returning at
 * the mark while the abandoned handler's lock round and append were still in
 * flight let the cut vanish with the process.
 */
export const bookLandedProbeCut = async (booking: LandedProbeCutBooking): Promise<void> => {
  const id = `${booking.sessionId}\n${booking.toolUseId ?? ""}`;
  const inFlight = booked.get(id);
  if (inFlight !== undefined) {
    await inFlight;
    return;
  }
  const writing = writeCut(booking);
  booked.set(id, writing);
  await writing;
};
