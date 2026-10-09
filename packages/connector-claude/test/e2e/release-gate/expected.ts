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
 * I1, decided by the owner: an opted-out teammate working on the file right
 * now is an anonymous live warning for the other side ("a teammate is working
 * on <file> right now"). Track C implemented it (merged at a5f569d8; its own
 * focused gate, release-gate-opted-out.e2e.test.ts, passes): a nameless
 * teammate is ONE group, told once. In this case Nick's subagents meet her
 * first, so the main thread's own edit — the moment P2.told reads — has
 * nothing new to tell, and the person hears it by relay instead. Which of the
 * two the decision means is for the owner: a finding, reported; the
 * assertion is not weakened to make it pass.
 */
const I1_ANONYMOUS_LIVE_WARNING: ExpectedFailure = { finding: "I1", track: "C", branch: "fix/b2-privacy-seams" };
/**
 * M5: an opted-out teammate's creation instants read as "last seen". Track C
 * fixed the statusline (P2.anonymous.when.statusline passes since its
 * merge); the briefing's age line ("Mike, 2s ago") is a separate render and
 * still says when. A finding, reported.
 */
const M5_LAST_SEEN: ExpectedFailure = { finding: "M5", track: "C", branch: "fix/b2-privacy-seams" };

/**
 * WHAT EVERY PROFILE SHOWS, timing or not: the opted-out case (P2,
 * release-gate/gate-opted-out.ts) — the owner's decision on I1 and the
 * review's M5, which P2 reads on two surfaces. The generous variant's whole
 * table.
 */
export const OWNER_DECISIONS_PENDING: Expectations = {
  // Track C (I1, the owner's decision): Mike has opted out and is working on PlayerMappingGrid.tsx
  // right now; Nick's main-thread edit of it must tell NICK that a teammate is on it.
  "P2.told": I1_ANONYMOUS_LIVE_WARNING,
  // Track C (M5): Nick's briefing reads "Mike, 2s ago" — an instant derived from Mike's work's creation.
  "P2.anonymous.when.briefing": M5_LAST_SEEN,
};

/**
 * THE BATCH-2 FINDINGS the realistic gate shows (production and loaded lanes)
 * on feat/crosscheck-batch-1006 with tracks A, B, C and D merged. Flipped on
 * the merge of track E (2026-10-09): R1 (track B's H2) and
 * P2.anonymous.when.statusline (track C's M5) pass and lost their markers.
 * Flipped by fix/b2-fanout (2026-10-09): the eight H1 cases (1d, 5a–5c,
 * L1–L4) — a compact dropped the life's seen-set and the git lane's cap was
 * one tool call's twenty, so the pilot's Bash-only files and a resumed
 * life's re-filing never reached the hub at pilot scale; both are fixed and
 * the cases are plain tests again. What is left is the owner's two decisions.
 * Track C's H3–H5 have no line: no gate case hashes topic ids, polls the
 * landed stop or ranks hints as an opted-out developer's colleague; P2's
 * anonymity check (plain) holds.
 */
export const BATCH_2_FINDINGS: Expectations = {
  ...OWNER_DECISIONS_PENDING,
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
