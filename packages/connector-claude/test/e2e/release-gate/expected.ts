/**
 * EXPECTED FAILURES, per gate file. A case's assertion that fails ONLY because
 * of a finding another track is fixing is registered as `test.failing`, and
 * the table that says so names the finding, the track and its branch — so
 * the marker goes the day that branch merges and the test turns green (bun
 * then reports the `test.failing` as a failure: a fixed finding cannot hide
 * behind its marker). An assertion that fails and is NOT in a table is a gap
 * nobody is fixing yet: it stays a plain, red `test`.
 *
 * The assertion is never weakened to make room for a finding: the marker is
 * the only difference between a gate file that expects a finding and one
 * that does not.
 */
import { test } from "bun:test";

export interface ExpectedFailure {
  /** The review finding (designs/review-batch2-integration.md). */
  readonly finding: string;
  readonly track: "A" | "B" | "C";
  readonly branch: "fix/b2-capture-across-lives" | "fix/b2-hook-order-budgets" | "fix/b2-privacy-seams";
}

/** Test id (the prefix of its name, e.g. "1d") → why it is expected to fail. */
export type Expectations = Readonly<Record<string, ExpectedFailure>>;

export const NONE_EXPECTED: Expectations = {};

/** H1: a compaction or a resume restarts the git lane's window, so work from before it is never filed again. */
const H1_CAPTURE_ACROSS_LIVES: ExpectedFailure = { finding: "H1", track: "A", branch: "fix/b2-capture-across-lives" };
/** H2: PreToolUse writes the person's record last, after its spare budget or a second lock round is gone. */
const H2_PERSON_RECORD_LAST: ExpectedFailure = { finding: "H2", track: "B", branch: "fix/b2-hook-order-budgets" };

/**
 * THE BATCH-2 FINDINGS the realistic gate shows (production and loaded lanes),
 * on feat/crosscheck-batch-1006 at 5a544fff. Each line goes when its branch
 * merges. Track C (fix/b2-privacy-seams: H3–H5) has no line: no gate case
 * reads a route as an opted-out developer's colleague.
 */
export const BATCH_2_FINDINGS: Expectations = {
  // Track A, fix/b2-capture-across-lives (H1, compaction): the codegen worker's six Bash-only files
  // land after the turn's lane and before the compaction; every later lane's window starts at the
  // compaction, so none of them is ever filed. The same case without the compaction passes all four.
  "1d": H1_CAPTURE_ACROSS_LIVES,
  "5a": H1_CAPTURE_ACROSS_LIVES,
  "5b": H1_CAPTURE_ACROSS_LIVES,
  "5c": H1_CAPTURE_ACROSS_LIVES,
  // Track A, fix/b2-capture-across-lives (H1, resume): after SessionEnd the old life's contexts leave
  // every collision surface, and the resumed life's lanes file only what changed after the resume —
  // Mike sees none of the 11 files Nick still has dirty or untracked on disk.
  L1: H1_CAPTURE_ACROSS_LIVES,
  L2: H1_CAPTURE_ACROSS_LIVES,
  L3: H1_CAPTURE_ACROSS_LIVES,
  L4: H1_CAPTURE_ACROSS_LIVES,
  // Track B, fix/b2-hook-order-budgets (H2): a foreground hit whose agent WAS warned (so its claim
  // won the locked write) is missing from Nick's record when the turn ends — `tellPerson` writes it
  // last, after the spare budget ran out or its own lock round failed under the fan-out.
  R1: H2_PERSON_RECORD_LAST,
};

/** `test`, or `test.failing` when `expected` names `id`. */
export const gateTest = (
  expected: Expectations,
  id: string,
  name: string,
  body: () => void | Promise<void>,
): void => {
  const register = expected[id] === undefined ? test : test.failing;
  register(`${id}: ${name}`, body);
};
