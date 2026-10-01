/**
 * The sweep's pure bookkeeping (A1.6 / H1): the five-void cap, and which slots
 * a resumed run still owes. The IO — spawning, writing outcomes — lives in
 * cli.ts; this module is the arithmetic, so the "re-run in the same slot",
 * "cap of five" and "resume rather than restart" rules are unit-tested.
 *
 * A void run is re-run IN ITS SLOT until it counts; every void attempt (a
 * record-derived void OR a harness throw) counts toward the cap. More than five
 * voids in all is harness trouble and voids the whole measurement — the sweep
 * aborts rather than quietly re-running until the number comes out right.
 */
import type { Slot } from "./manifest.ts";

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
