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

/**
 * H1: a compaction or a resume restarts the git lane's window, so work from
 * before it is never filed again. Track A merged into batch 2 at 33f48cd3 and
 * its own tests pass, but the realistic gate still fails all eight H1 cases
 * on the merged tree (production lane, 2026-10-09): Nick's subagent-stop git
 * lane timed out under the fan-out (state/losses.jsonl hook_timed_out), the
 * Bash-only files never reached the hub (5a), Mike's statusline counted 8
 * files, not 11 (1d), and after the resume his tripwire warned about Nick on
 * 0 of the 11 (L1). A finding, reported; the marker stays until it is fixed.
 */
const H1_CAPTURE_ACROSS_LIVES: ExpectedFailure = { finding: "H1", track: "A", branch: "fix/b2-capture-across-lives" };

/**
 * WHAT EVERY PROFILE SHOWS, timing or not: the opted-out case (P2,
 * release-gate/gate-opted-out.ts). The generous variant's whole table.
 *
 * Empty since 2026-10-09 (fix/b2-integration-lows). Its two markers came off:
 *  - I1 (P2.told): the owner's decision read as the coordinator decided it —
 *    a nameless teammate is ONE group, told once, and Nick's subagents meet
 *    Mike's file first, so the person hears it by relay before his own edit.
 *    The assertion now reads from the first subagent hit through that edit.
 *  - M5 (P2.anonymous.when.briefing): the briefing, the pointer hint and the
 *    search line print no age off a row the hub marked withheld.
 */
export const OWNER_DECISIONS_PENDING: Expectations = {};

/**
 * THE BATCH-2 FINDINGS the realistic gate shows (production and loaded lanes)
 * on feat/crosscheck-batch-1006 with tracks A, B, C and D merged. Flipped on
 * the merge of track E (2026-10-09): R1 (track B's H2) and
 * P2.anonymous.when.statusline (track C's M5) pass and lost their markers.
 * What is left fails on the merged tree and is reported as a finding. Track
 * C's H3–H5 have no line: no gate case hashes topic ids, polls the landed
 * stop or ranks hints as an opted-out developer's colleague; P2's anonymity
 * check (plain) holds.
 */
export const BATCH_2_FINDINGS: Expectations = {
  ...OWNER_DECISIONS_PENDING,
  // Track A (H1, compaction): the codegen worker's six Bash-only files land after the turn's lane
  // and before the compaction, and are never filed.
  "1d": H1_CAPTURE_ACROSS_LIVES,
  "5a": H1_CAPTURE_ACROSS_LIVES,
  "5b": H1_CAPTURE_ACROSS_LIVES,
  "5c": H1_CAPTURE_ACROSS_LIVES,
  // Track A (H1, resume): after SessionEnd and the resume, Mike sees none of the 11 files Nick still
  // has dirty or untracked on disk.
  L1: H1_CAPTURE_ACROSS_LIVES,
  L2: H1_CAPTURE_ACROSS_LIVES,
  L3: H1_CAPTURE_ACROSS_LIVES,
  L4: H1_CAPTURE_ACROSS_LIVES,
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
