/**
 * The sweep's pure bookkeeping (A1.6 / H1, A2.5): the five-void cap, which
 * slots a resumed run still owes, and the LEDGER read back from the attempts
 * already on disk. The IO — spawning, writing outcomes — lives in driver.ts and
 * attempt-store.ts; this module is the arithmetic, so the "re-run in the same
 * slot", "cap of five" and "resume rather than restart" rules are unit-tested.
 *
 * A void run is re-run IN ITS SLOT until it counts; every void attempt (a
 * record-derived void, a harness throw, OR an attempt directory left without
 * an outcome) counts toward the cap. More than five voids in all is harness
 * trouble and voids the whole measurement — the sweep aborts rather than
 * quietly re-running until the number comes out right. Attempt numbers
 * continue after the highest one on disk, so a resume never reuses one.
 */
import type { Arm, Slot } from "./manifest.ts";
import type { RunOutcome } from "./report.ts";

/** §7 / A1.6: more than five void attempts in total void the measurement. */
export const VOID_BUDGET = 5;

export interface SweepProgress {
  /** Void attempts so far, across every slot. */
  readonly voidAttempts: number;
  /** True once the budget is exceeded — the measurement is harness-void. */
  readonly aborted: boolean;
}

export const INITIAL_PROGRESS: SweepProgress = {
  voidAttempts: 0,
  aborted: false,
};

/** One more void attempt; the sweep aborts once the cap is exceeded. */
export const recordVoidAttempt = (progress: SweepProgress): SweepProgress => {
  const voidAttempts = progress.voidAttempts + 1;
  return { voidAttempts, aborted: voidAttempts > VOID_BUDGET };
};

/**
 * The slots a resumed sweep still owes: those whose index is not already
 * completed with a valid (non-void) outcome. Order is preserved, so a resume
 * continues where it left off rather than restarting at slot 0.
 */
export const remainingSlots = (
  order: readonly Slot[],
  completedIndices: Iterable<number>,
): readonly Slot[] => {
  const done = new Set(completedIndices);
  return order.filter((slot) => !done.has(slot.index));
};

/** What the sweep writes the moment an attempt starts (attempt.json). */
export interface AttemptRecord {
  readonly attemptId: string;
  readonly slotIndex: number;
  readonly arm: Arm;
  readonly attempt: number;
  readonly workRoot: string;
  /** ISO-8601. */
  readonly startedAt: string;
}

/** An attempt read back from disk; `outcome` is null when it never finished. */
export interface StoredAttempt {
  readonly record: AttemptRecord;
  readonly outcome: RunOutcome | null;
}

export interface AttemptLedger {
  /** One outcome per stored attempt — an unfinished one as interrupted. */
  readonly outcomes: readonly RunOutcome[];
  /** The counted (non-void) outcome of each slot already won. */
  readonly winners: ReadonlyMap<number, RunOutcome>;
  readonly voidAttempts: number;
  /** The highest attempt number on disk, per slot. */
  readonly lastAttempt: ReadonlyMap<number, number>;
}

/** The void outcome of an attempt whose directory has no outcome (A2.5). */
export const interruptedOutcome = (record: AttemptRecord): RunOutcome => ({
  slotIndex: record.slotIndex,
  arm: record.arm,
  attemptId: record.attemptId,
  attempt: record.attempt,
  token: "",
  hits: [],
  voids: ["attempt-interrupted"],
  taskSucceeded: false,
  toolCallCount: 0,
  turns: null,
  durationMs: null,
  costUsd: null,
  filesRead: [],
  filesWritten: [],
  filesEdited: [],
  bashCommands: [],
  toolNames: [],
  todoItems: [],
  claudeVersion: "",
});

/** The ledger of the attempts on disk, in attempt order. Pure. */
export const ledgerOf = (stored: readonly StoredAttempt[]): AttemptLedger => {
  const ordered = [...stored].sort(
    (a, b) => a.record.slotIndex - b.record.slotIndex || a.record.attempt - b.record.attempt,
  );
  const outcomes = ordered.map((entry) => entry.outcome ?? interruptedOutcome(entry.record));
  const winners = new Map<number, RunOutcome>();
  const lastAttempt = new Map<number, number>();
  for (const [i, outcome] of outcomes.entries()) {
    const { record } = ordered[i] as StoredAttempt;
    lastAttempt.set(record.slotIndex, Math.max(lastAttempt.get(record.slotIndex) ?? 0, record.attempt));
    if (outcome.voids.length === 0 && !winners.has(record.slotIndex)) {
      winners.set(record.slotIndex, outcome);
    }
  }
  const voidAttempts = outcomes.filter((outcome) => outcome.voids.length > 0).length;
  return { outcomes, winners, voidAttempts, lastAttempt };
};

/** The next attempt number for a slot: one past the highest on disk. */
export const nextAttemptNumber = (ledger: AttemptLedger, slotIndex: number): number =>
  (ledger.lastAttempt.get(slotIndex) ?? 0) + 1;
