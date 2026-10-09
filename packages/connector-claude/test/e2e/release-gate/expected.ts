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
 * Flipped by fix/b2-fanout (2026-10-09): the eight H1 cases (1d, 5a–5c,
 * L1–L4) — a compact dropped the life's seen-set and the git lane's cap was
 * one tool call's twenty, so the pilot's Bash-only files and a resumed
 * life's re-filing never reached the hub at pilot scale; both are fixed and
 * the cases are plain tests again. With the owner's two decisions off too
 * (above), the table is empty: every batch-2 case is a plain test.
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
