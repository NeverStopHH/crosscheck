/**
 * The conclusion-capture corpus — the gate+prompt's precision instrument for
 * CONCLUSION moments, sibling of the hint pipeline's precision corpus
 * (connector-core/test/fixtures/precision-corpus). Trial finding #12 is why it
 * exists: a full day of releases, adversarial reviews, mechanism-level fixes
 * and merges produced ZERO claims, because the Stop gate and the distillation
 * prompt recognized only DEBUGGING moments. This corpus is the spec for the
 * widened gate: every fixture is a transcript slice modeled on a REAL shape
 * from this project's own history, and test/conclusion-corpus.test.ts holds
 * the gate and the worker to it.
 *
 * TWO KINDS OF FIXTURE, one contract each:
 *   expect "draft"  — the gate must fire, and the fixture's `distillation`
 *                     (what a correct summarizer answers for this slice) must
 *                     flow through the REAL worker/spool path into exactly one
 *                     draft of the stated kind whose body carries `bodyPins` —
 *                     the teammate-actionable content, pinned.
 *   expect "none"   — the gate must stay silent, and a summarizer answering
 *                     NONE must spool nothing. Progress narration, plans,
 *                     praise and test-green noise live here; NONE stays the
 *                     right answer for chatter.
 *
 * `loadBearing` names the ONE predicate a fixture exists to hold in place —
 * the mutation catalogue (connector-core/scripts/mutation-check.ts) deletes
 * that predicate from the gate and this corpus must go red on exactly that
 * fixture. A fixture whose firing is over-determined cannot pin anything.
 */
import type { ClaimKind } from "@crosscheck/schema";

/** What a correct distiller answers for a positive fixture's slice. */
export interface Distillation {
  readonly kind: ClaimKind;
  readonly body: string;
  readonly confidence: number;
}

export interface ConclusionFixture {
  readonly name: string;
  readonly expect: "draft" | "none";
  /** Claude Code JSONL, one transcript entry per line — the real wire shape. */
  readonly transcript: string;
  /** Positive fixtures only. */
  readonly distillation?: Distillation;
  /** Substrings the spooled body must carry — the actionability pin. */
  readonly bodyPins?: readonly string[];
  /** The predicate this fixture holds in place (positives only). */
  readonly loadBearing?: string;
  /** Which real moment this models — the corpus's honesty trail. */
  readonly note: string;
}

const line = (entry: unknown): string => `${JSON.stringify(entry)}\n`;

export const userText = (text: string): string =>
  line({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });

export const assistantText = (text: string): string =>
  line({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });

export const assistantToolUse = (name: string, input: unknown): string =>
  line({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", name, input }] },
  });

export const toolResult = (content: string): string =>
  line({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", content }] },
  });

/**
 * P1 — an adversarial review that found a CRITICAL (the secret-egress
 * finding: the hint query shipped the raw prompt to the hub unscanned).
 * The ONLY work anchor in this slice is the review-finding shape — no test
 * command, no error-class output, no commit — so deleting review-finding
 * recognition from the gate must silence exactly this fixture.
 */
const adversarialReviewCritical: ConclusionFixture = {
  name: "adversarial_review_critical",
  expect: "draft",
  loadBearing: "hasReviewFindingShape",
  note: "models the Block-7 secret-egress review finding (mutation catalogue: 'the hint query ships to the hub with no secret scan')",
  transcript:
    userText("run the adversarial review over the hint pipeline") +
    assistantText(
      "Finding 1 (CRITICAL): the capture path drops secret-bearing text, " +
        "but the SAME text doubles as the hint query and goes to the hub " +
        "unscanned — in a GET string, straight into shared access logs. " +
        "The adversarial review confirmed that a failing curl with an " +
        "Authorization header reaches the hub verbatim. The gate belongs in " +
        "the shared flow: one containsSecret call before the candidates " +
        "round trip covers every connector at once.",
    ),
  distillation: {
    kind: "evidence",
    body:
      "Adversarial review confirmed the hint query ships the raw prompt to " +
      "the hub unscanned: secret-bearing tool output lands in shared access " +
      "logs. The gate is one containsSecret call in the shared hint flow, " +
      "before the candidates round trip, so it covers every connector.",
    confidence: 0.45,
  },
  bodyPins: ["containsSecret", "unscanned", "access logs"],
};

/**
 * P2 — a fixer disposition: an approach considered and RULED OUT with the
 * reason stated. The conclusion signal is rejection language ALONE (no
 * verdict wording, no suite flip), so deleting rejection recognition must
 * silence exactly this fixture. The anchor is the numbered-finding shape.
 */
const fixerDispositionRuledOut: ConclusionFixture = {
  name: "fixer_disposition_ruled_out",
  expect: "draft",
  loadBearing: "hasRejectionLanguage",
  note: "models the leaderboard first-load triage: cache pre-warming vs the 2-minute seal invalidation",
  transcript:
    userText("work the disposition table for the leaderboard findings") +
    assistantText(
      "Finding 4: pre-warming the rollup cache is ruled out — the seal " +
        "invalidates every rollup every 2 minutes, so warmed entries die " +
        "before their first read. Any cache work before the invalidation " +
        "cadence changes is wasted effort; the cadence is the real lever.",
    ),
  distillation: {
    kind: "rejected_approach",
    body:
      "Pre-warming the rollup cache is ruled out: the seal invalidates " +
      "every rollup every 2 minutes, so warmed entries die before their " +
      "first read — change the invalidation cadence before attempting any " +
      "cache-side work.",
    confidence: 0.4,
  },
  bodyPins: ["ruled out", "seal invalidates", "cadence"],
};

/**
 * P3 — a whole-branch gate verdict after a full suite run. The conclusion
 * signal is verdict language ALONE (no rejection, no red marker anywhere, so
 * no flip), so deleting verdict recognition must silence exactly this
 * fixture. The anchor is the test command in the run itself.
 */
const branchGateVerdict: ConclusionFixture = {
  name: "branch_gate_verdict",
  expect: "draft",
  loadBearing: "hasVerdictLanguage",
  note: "models the 0.6.x pre-merge gauntlet verdicts (1658/0 across 170 files, cpu-lane skips environmental)",
  transcript:
    userText("run the full gauntlet on the summarizer branch and call it") +
    assistantToolUse("Bash", { command: "bun test" }) +
    toolResult("1658 pass, 0 skip across 170 files. Ran 1658 tests.") +
    assistantText(
      "Verdict: the summarizer branch is safe to merge. The gauntlet came " +
        "back clean — 1658 pass across 170 files — and the three cpu-lane " +
        "skips are environmental, the same three main carries.",
    ),
  distillation: {
    kind: "decision",
    body:
      "The summarizer branch cleared the full gauntlet — 1658 pass across " +
      "170 files — and is safe to merge; the three cpu-lane skips are " +
      "environmental, the same three main carries, not regressions.",
    confidence: 0.4,
  },
  bodyPins: ["safe to merge", "cpu-lane skips"],
};

/**
 * P4 — a mechanism-level root-cause explanation (the deferred-end livelock).
 * This is the DEBUGGING wing inside the widened gate: error output plus
 * hypothesis language, exactly the pre-widening heuristics — pinned here so
 * widening can never cost the wing that already worked.
 */
const mechanismRootCause: ConclusionFixture = {
  name: "mechanism_root_cause_livelock",
  expect: "draft",
  loadBearing: "isDiagnosisMoment",
  note: "models the CI 'Concurrency (repeated)' deferred-end starvation diagnosis (spool/reap.ts holdback)",
  transcript:
    userText("why does the deferred end never ship on CI") +
    assistantToolUse("Bash", { command: "bun test packages/connector-claude" }) +
    toolResult(
      "2 tests failed — deferred end never flushed; TimeoutError in hook-budget.test.ts",
    ) +
    assistantText(
      "The root cause is a livelock, not a race: SessionStart's drain " +
        "spends the whole spare budget, and because registration guarantees " +
        "the spool is never empty, the ender always reads roomMs 0. The " +
        "deferred end then waits out its age-out instead of costing one " +
        "bounded call.",
    ),
  distillation: {
    kind: "root_cause",
    body:
      "The deferred end starves by livelock, not by a race: SessionStart's " +
      "drain spends the whole spare budget while registration guarantees a " +
      "non-empty spool, so the ender always reads roomMs 0 and the end " +
      "waits out its age-out instead of costing one bounded call.",
    confidence: 0.5,
  },
  bodyPins: ["livelock", "roomMs 0", "spare budget"],
};

/**
 * P5 — a version-bump/merge moment: the commit boundary is the ONLY work
 * anchor (no test command, no error words, no numbered findings, no red
 * output), so deleting commit-boundary recognition must silence exactly this
 * fixture. The conclusion signal is the decision prose beside the commit.
 */
const versionBumpMerge: ConclusionFixture = {
  name: "version_bump_merge",
  expect: "draft",
  loadBearing: "hasCommitBoundary",
  note: "models the 0.6.1 release commit (drain holdback shipping on by default)",
  transcript:
    userText("cut the release") +
    assistantToolUse("Bash", {
      command:
        'git commit -m "chore: 0.6.1 — trial fixes and the drain holdback ship"',
    }) +
    toolResult(
      "[main 5730ea5] chore: 0.6.1 — trial fixes and the drain holdback ship",
    ) +
    assistantText(
      "Decided to ship 0.6.1 with the drain holdback on by default: a " +
        "start-hosted flush must always leave the deferred ender room for " +
        "one bounded call, whatever the spool depth.",
    ),
  distillation: {
    kind: "decision",
    body:
      "0.6.1 ships with the drain holdback on by default: a start-hosted " +
      "flush must always leave the deferred ender room for one bounded " +
      "call, whatever the spool depth.",
    confidence: 0.35,
  },
  bodyPins: ["holdback", "bounded call"],
};

/**
 * P6 — a suite flipping red→green with the mechanism stated but NO verdict
 * or rejection vocabulary anywhere: the flip itself is the conclusion
 * signal, so neutralizing flip recognition must silence exactly this
 * fixture. The anchor rides the red half's failure output.
 */
const suiteFlipFix: ConclusionFixture = {
  name: "suite_flip_red_green",
  expect: "draft",
  loadBearing: "hasSuiteFlip",
  note: "models the double-spend wedge clearing once cap+debounce re-check moved inside the locked transform",
  transcript:
    userText("make the racing stop hooks stop double-spending the slot") +
    toolResult("3 fail — double fire recorded across racing siblings") +
    assistantText(
      "Re-checking cap and debounce on the fresh state inside the locked " +
        "transform is what un-wedged it: the suite went from 3 fail to " +
        "1658 pass, 0 fail.",
    ),
  distillation: {
    kind: "evidence",
    body:
      "The double-spend wedge cleared once cap and debounce are re-checked " +
      "on the fresh state inside the locked transform — the suite went " +
      "from 3 fail to 1658 pass, 0 fail.",
    confidence: 0.4,
  },
  bodyPins: ["locked transform", "0 fail"],
};

/**
 * P7 — a review whose ENTIRE output is a findings list: severity labels and
 * defect statements, no verdict, rejection or flip vocabulary anywhere. The
 * fix-round recall finding (MEDIUM-2): deep adversarial reviews print
 * severity + defect, and the shipped P1 only fired because its prose
 * happened to add "confirmed that" — the modal tooling shape itself must
 * fire. The SIGNAL is the punctuated-severity-in-review-context shape;
 * deleting hasReviewFindingSignal must silence exactly this fixture.
 */
const pureFindingsList: ConclusionFixture = {
  name: "pure_findings_list",
  expect: "draft",
  loadBearing: "hasReviewFindingSignal",
  note: "models a severity-labels-only adversarial review report — no verdict prose anywhere (fix round for trial finding #12's headline class)",
  transcript:
    userText("review the summarizer branch") +
    assistantText(
      "Finding 3 (HIGH): the cap is never re-checked after the lock is " +
        "taken, so racing stop hooks double-spend the summarizer slot. " +
        "Finding 4 (MEDIUM): the spool reader holds the file handle across " +
        "the await, pinning the directory on Windows.",
    ),
  distillation: {
    kind: "evidence",
    body:
      "Review found the summarizer cap is never re-checked after the lock " +
      "is taken — racing stop hooks double-spend the slot — and the spool " +
      "reader holds its file handle across the await, pinning the " +
      "directory on Windows.",
    confidence: 0.45,
  },
  bodyPins: ["re-checked", "double-spend"],
};

/** N1 — a status update: work happened, nothing was concluded. */
const statusUpdate: ConclusionFixture = {
  name: "status_update",
  expect: "none",
  note: "progress narration must never become a claim (trial finding #12's counterweight)",
  transcript:
    userText("where are we") +
    assistantToolUse("Bash", { command: "bun test packages/connector-claude" }) +
    toolResult("212 pass, 0 skip. Ran 212 tests.") +
    assistantText(
      "Status: the worker and the spool path are implemented, and " +
        "everything is green so far. I still need to wire the cost surface " +
        "and write the docs.",
    ),
};

/** N2 — plan narration: intentions are not knowledge. */
const planNarration: ConclusionFixture = {
  name: "plan_narration",
  expect: "none",
  note: "plans anchor teammates on work that may never happen — never claim-worthy",
  transcript:
    userText("how will you approach the corpus") +
    assistantText(
      "The plan: first widen the gate, then reshape the prompt, then build " +
        "the fixture corpus and drive it through the worker. I will start " +
        "with the gate and keep the debounce untouched.",
    ),
};

/** N3 — small talk. */
const smallTalk: ConclusionFixture = {
  name: "small_talk",
  expect: "none",
  note: "chatter yields NONE, always",
  transcript:
    userText("morning! coffee first, then the review") +
    assistantText("Good morning — ready when you are."),
};

/** N4 — test-green noise: a green run narrated, with nothing concluded. */
const testGreenNoise: ConclusionFixture = {
  name: "test_green_noise",
  expect: "none",
  note: "'tests pass now' is progress, not a conclusion — NONE stays right",
  transcript:
    userText("run them again") +
    assistantToolUse("Bash", { command: "bun test" }) +
    toolResult("1658 pass, 0 skip across 170 files. Ran 1658 tests.") +
    assistantText("All green. Moving on to the docs next."),
};

/** N5 — praise: quality talk is not knowledge. */
const praise: ConclusionFixture = {
  name: "praise",
  expect: "none",
  note: "praise must never be distilled into a claim",
  transcript:
    userText("thoughts on the refactor?") +
    assistantText(
      "Excellent work — the extraction reads much cleaner now and the " +
        "naming is consistent throughout.",
    ),
};

// ---------------------------------------------------------------------------
// N6–N13: the fix round's HARD negatives — every one is a probe that FIRED
// the shipped v1 gate during the adversarial review (noise findings HIGH-1
// and the two precision MEDIUMs). They sit just INSIDE realistic phrasing
// where N1–N5 were each crafted just outside the regex boundary, so the 1.0
// silence floor now means something about real days, not corpus-shaped days.
// ---------------------------------------------------------------------------

/** N6 — review HIGH-1 probe (a): "error handling" narration beside green tests. */
const errorHandlingProgress: ConclusionFixture = {
  name: "error_handling_progress",
  expect: "none",
  note: "fired v1 via the flip's bare-word 'error' red half — progress narration, nothing concluded",
  transcript:
    userText("keep going") +
    assistantText(
      "Added error handling to the importer and the tests are passing now. " +
        "Wiring the cost surface next.",
    ),
};

/** N7 — review probes (b, and R2's decision-pending): an OPEN decision beside a real test run. */
const decisionPending: ConclusionFixture = {
  name: "decision_pending",
  expect: "none",
  note: "fired v1 via the bare noun 'decision' — an explicitly undecided question must never spend a slot",
  transcript:
    userText("where do we stand on the cache layer") +
    assistantToolUse("Bash", { command: "bun test packages/api" }) +
    toolResult("212 pass, 0 skip. Ran 212 tests.") +
    assistantText(
      "The decision on the cache layer is still open — no decision yet; I " +
        "need Nick's call before touching the eviction path.",
    ),
};

/** N8 — review HIGH-1 probe (c): "In conclusion" opening a status summary. */
const inConclusionStatus: ConclusionFixture = {
  name: "in_conclusion_status",
  expect: "none",
  note: "fired v1 via the bare noun 'conclusion' — a summary opener is not a verdict",
  transcript:
    userText("summarize the day") +
    assistantToolUse("Bash", { command: "bun test" }) +
    toolResult("212 pass, 0 skip. Ran 212 tests.") +
    assistantText(
      "In conclusion, here is where we are: the worker is done, docs are " +
        "pending, and nothing is blocked.",
    ),
};

/** N9 — review HIGH-1 probe (d): a hoped-for fix narrated, nothing proven. */
const shouldBeFixedNoise: ConclusionFixture = {
  name: "should_be_fixed_noise",
  expect: "none",
  note: "fired v1 via bare-word 'error' + 'tests are green' — 'should be gone' is hope, not a conclusion",
  transcript:
    userText("is login fixed?") +
    assistantText(
      "The connection error should be gone and login should work now — the " +
        "tests are green on my machine.",
    ),
};

/** N10 — review HIGH-1 probe (e): self-praise naming the error class it fixed. */
const praiseWithErrorName: ConclusionFixture = {
  name: "praise_with_error_name",
  expect: "none",
  note: "fired v1 via 'TypeError' as the flip's red half inside a wholly green report",
  transcript:
    userText("nice") +
    assistantText(
      "I fixed the TypeError earlier and the suite is green — clean run, " +
        "nice work all around.",
    ),
};

/** N11 — review HIGH-1 probe (f): a shouted CRITICAL with the decision explicitly unmade. */
const criticalShoutNoDecision: ConclusionFixture = {
  name: "critical_shout_no_decision",
  expect: "none",
  note: "fired v1 via shouted CRITICAL anchor + bare 'decision' — emphasis is not a finding, pending is not a verdict",
  transcript:
    userText("anything else before I leave?") +
    assistantText(
      "It is CRITICAL that we not forget the backup before the migration. " +
        "No decision yet on the cutover window.",
    ),
};

/** N12 — R2's green-run probe: an error class inside a ✓ test NAME, suite wholly green. */
const greenRunErrorTestName: ConclusionFixture = {
  name: "green_run_error_test_name",
  expect: "none",
  note: "fired v1 via 'TypeError' in a passing test's name — a wholly green run must never provide its own red",
  transcript:
    userText("run them again") +
    assistantToolUse("Bash", { command: "bun test" }) +
    toolResult(
      "✓ handles TypeError in parser\n✓ recovers the reader after close\n" +
        "212 pass\n0 fail\nRan 212 tests.",
    ) +
    assistantText("All green, moving on."),
};

/** N13 — R2's anti-conclusion probe: red output mid-bisect, conclusion explicitly absent. */
const bisectingNoConclusion: ConclusionFixture = {
  name: "bisecting_no_conclusion",
  expect: "none",
  note: "fired v1 via bare 'conclusion' + error anchor — an explicit NOT-concluded is the clearest non-moment there is",
  transcript:
    userText("keep bisecting") +
    toolResult("TimeoutError: hook-budget.test.ts exceeded 5000ms") +
    assistantText(
      "No conclusion yet — still bisecting the failure window; three " +
        "commits left.",
    ),
};

export const loadConclusionCorpus = (): readonly ConclusionFixture[] => [
  adversarialReviewCritical,
  fixerDispositionRuledOut,
  branchGateVerdict,
  mechanismRootCause,
  versionBumpMerge,
  suiteFlipFix,
  pureFindingsList,
  statusUpdate,
  planNarration,
  smallTalk,
  testGreenNoise,
  praise,
  errorHandlingProgress,
  decisionPending,
  inConclusionStatus,
  shouldBeFixedNoise,
  praiseWithErrorName,
  criticalShoutNoDecision,
  greenRunErrorTestName,
  bisectingNoConclusion,
];
