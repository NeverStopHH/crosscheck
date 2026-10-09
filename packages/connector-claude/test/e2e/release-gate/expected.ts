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

/** H1: a compaction or a resume restarts the git lane's window, so work from before it is never filed again. */
const H1_CAPTURE_ACROSS_LIVES: ExpectedFailure = { finding: "H1", track: "A", branch: "fix/b2-capture-across-lives" };
/** H2: PreToolUse writes the person's record last, after its spare budget or a second lock round is gone. */
const H2_PERSON_RECORD_LAST: ExpectedFailure = { finding: "H2", track: "B", branch: "fix/b2-hook-order-budgets" };
/**
 * I1, decided by the owner: an opted-out teammate working on the file right
 * now is an anonymous live warning for the other side ("a teammate is working
 * on <file> right now"). On 5a544fff the hub drops a hidden owner's sessions
 * from the tripwire whole, so Nick is told nothing.
 */
const I1_ANONYMOUS_LIVE_WARNING: ExpectedFailure = { finding: "I1", track: "C", branch: "fix/b2-privacy-seams" };
/** M5: an opted-out teammate's creation instants read as "last seen" (statusline, briefing). */
const M5_LAST_SEEN: ExpectedFailure = { finding: "M5", track: "C", branch: "fix/b2-privacy-seams" };

/**
 * WHAT EVERY PROFILE SHOWS, timing or not: the opted-out case (P2,
 * release-gate/gate-opted-out.ts) — the owner's decision on I1, decided after
 * 5a544fff, and the review's M5, which P2 reads on two surfaces. The generous
 * variant's whole table.
 */
export const OWNER_DECISIONS_PENDING: Expectations = {
  // Track C, fix/b2-privacy-seams (I1, the owner's decision): Mike has opted out and is working on
  // PlayerMappingGrid.tsx right now; Nick's edit of it must tell NICK that a teammate is on it.
  "P2.told": I1_ANONYMOUS_LIVE_WARNING,
  // Track C, fix/b2-privacy-seams (M5): Nick's statusline reads "Mike last seen 3s ago" and his
  // briefing "Mike, 1s ago" — instants derived from Mike's work's creation. e061fb94 on that branch
  // fixes the statusline (presence-cache.ts); the briefing's age line is a separate render.
  "P2.anonymous.when.statusline": M5_LAST_SEEN,
  "P2.anonymous.when.briefing": M5_LAST_SEEN,
};

/**
 * THE BATCH-2 FINDINGS the realistic gate shows (production and loaded lanes),
 * on feat/crosscheck-batch-1006 at 5a544fff, plus the owner's pending I1
 * decision. Each line goes when its branch merges. Track C's H3–H5 have no
 * line: no gate case hashes topic ids, polls the landed stop or ranks hints
 * as an opted-out developer's colleague; P2's anonymity check (plain) holds.
 */
export const BATCH_2_FINDINGS: Expectations = {
  ...OWNER_DECISIONS_PENDING,
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

/** Per table, the test ids registered against it — so a marker left on a renamed or removed test is caught. */
const registered = new WeakMap<Expectations, Set<string>>();

/** `test`, or `test.failing` when `expected` names `id`. */
export const gateTest = (
  expected: Expectations,
  id: string,
  name: string,
  body: () => void | Promise<void>,
): void => {
  registered.set(expected, new Set([...(registered.get(expected) ?? []), id]));
  const register = expected[id] === undefined ? test : test.failing;
  register(`${id}: ${name}`, body);
};

/** The ids `expected` names that no test registered against it. */
export const unregisteredExpectations = (expected: Expectations): readonly string[] =>
  Object.keys(expected).filter((id) => registered.get(expected)?.has(id) !== true);
