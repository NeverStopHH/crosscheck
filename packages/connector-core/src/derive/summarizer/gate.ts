/**
 * The deterministic gate in front of the Tier-1 summarizer (DESIGN.md §3
 * Tier 1). Everything here is decided BEFORE any LLM cost exists: cheap
 * regexes over the turn's transcript slice, a turn debounce, and the hard
 * per-session fire cap. The Stop hook runs these and either spawns the
 * detached worker or does nothing — it never waits on a model.
 *
 * TWO WINGS, ONE CONJUNCTION RULE. The gate recognizes DIAGNOSIS moments
 * (a test command ran or error output is present, AND hypothesis language)
 * and — since trial finding #12, where a full day of reviews, fixes and
 * merges produced zero claims — CONCLUSION moments: a verdict or decision
 * declared, an approach ruled out, a review finding stated, a suite flipping
 * red→green, a commit or merge landing. Both wings are conjunctions,
 * deliberately: conclusion language alone fires on planning chatter, and a
 * work anchor alone fires on every green build with nothing concluded.
 * Both misfires spend the developer's own quota (§10 risk 7) and fill the
 * hub with junk drafts (§10 risk 4), so precision beats recall on every
 * doubt — the conclusion-corpus fixtures
 * (test/fixtures/conclusion-corpus/format.ts) are the precision instrument
 * every predicate below answers to.
 */
import {
  SUMMARIZER_DEBOUNCE_TURNS,
  SUMMARIZER_FAILURE_MAX_CHARS,
  SUMMARIZER_MAX_FIRES_PER_SESSION,
} from "../../constants.ts";
import { cutWellFormed } from "../../briefing/cut.ts";
import type { SessionState } from "../../state/session-state.ts";

/**
 * A test runner invoked as a command. Anchored to a word boundary on both
 * sides so "we should test this later" and `ls contest/` do not count; the
 * runner name must be followed by a test-ish argument or subcommand. Both
 * boundary classes admit quotes because the slice renders tool_use input as
 * JSON — `tool_use Bash: {"command":"bun test"}` — where the characters
 * around the command are `"`, not whitespace.
 */
const TEST_COMMAND_PATTERN =
  /(?:^|[\s;&|("'])(?:(?:bun|npm|pnpm|yarn|npx)\s+(?:run\s+)?test|(?:go|cargo)\s+test|pytest|vitest|jest|rspec|phpunit|tox)(?:$|[\s.:/"'])/m;

/**
 * Error markers the way tools actually print them. `\w*error` covers the
 * class-name form (TypeError, AssertionError) the plain word boundary missed.
 */
const ERROR_OUTPUT_PATTERN =
  /\b(?:\w*error|\w*exception|traceback|panic|segfault|stack trace)\b|\b(?:\d+\s+)?(?:tests?\s+)?fail(?:ed|ure|ures)?\b|\(fail\)/i;

/** Diagnosis prose: someone is asserting a cause, not narrating an edit. */
const HYPOTHESIS_PATTERN =
  /\b(?:root cause|hypothes[ie]s|likely (?:cause|culprit|because)|i suspect|suspect(?:s|ed)? (?:that|the)|caused by|because (?:the|it|of)|the (?:bug|problem|issue|culprit|defect) (?:is|was|seems|turns out)|turns out|traced (?:it|this|the|back) to|due to (?:a|the))\b/i;

export const hasTestCommand = (text: string): boolean =>
  TEST_COMMAND_PATTERN.test(text);

export const hasErrorOutput = (text: string): boolean =>
  ERROR_OUTPUT_PATTERN.test(text);

export const hasHypothesisLanguage = (text: string): boolean =>
  HYPOTHESIS_PATTERN.test(text);

/** The debugging wing: evidence signal AND hypothesis language. */
export const isDiagnosisMoment = (sliceText: string): boolean =>
  (hasTestCommand(sliceText) || hasErrorOutput(sliceText)) &&
  hasHypothesisLanguage(sliceText);

// ---------------------------------------------------------------------------
// The conclusion wing (trial finding #12). Same philosophy, second vocabulary:
// a CONCLUSION SIGNAL (a verdict declared, an approach ruled out, a suite
// flipping red→green) AND a WORK ANCHOR (something actually happened in this
// slice — a test ran, errors printed, a review finding was stated in review
// shape, a commit landed). Each predicate is named and pinned on its own
// corpus fixture; scripts/mutation-check.ts deletes each from the fire
// condition and the corpus must go red.
// ---------------------------------------------------------------------------

/**
 * Verdict/decision prose: a conclusion being DECLARED, not planned. Past and
 * present declarations only — "will decide", "should decide", "start with"
 * stay out, because plans are the negative corpus's biggest class. The bare
 * nouns demand the punctuation a declaration gives them ("Verdict:",
 * "Decision —"): undecided uses ("no decision yet", "the decision is still
 * open", "In conclusion, here is where we are") each fired the v1 gate and
 * spent a capped slot on nothing (fix-round noise finding HIGH-1).
 */
const VERDICT_PATTERN =
  /\b(?:verdict|decision|conclusion)\s*[:—–]|\b(?:decid(?:ed|es) (?:to|on|against|that)|going with|went with|chose|opted (?:for|to)|settled on|confirmed that|safe to merge|ready to (?:merge|ship)|the fix (?:is|was)|fix(?:ed)? (?:it|this|that) by)\b/i;

/**
 * Rejection prose: an approach RULED OUT with the ruling stated. Past forms
 * only — "rule out", "ruling out" are investigation narration, not verdicts.
 * Case-insensitive like every prose pattern here: disposition tables start
 * entries with the capitalized verb ("Ruled out: …"), and the v1 pattern —
 * the one prose pattern without /i — missed exactly that modal form.
 */
const REJECTION_PATTERN =
  /\b(?:ruled out|rejected|not viable|(?:won'?t|will not|doesn'?t|does not|didn'?t|did not) work because|dead end|abandon(?:ed|ing) (?:the|this|that)|scrapp(?:ed|ing) (?:the|this|that)|discard(?:ed|ing) (?:the|this|that))\b/i;

/**
 * Review findings the way review tooling prints them. The severity labels
 * are CASE-SENSITIVE on purpose: "CRITICAL:" is a review artifact, "critical
 * path" is prose — and HIGH/MEDIUM/LOW additionally demand the punctuation a
 * findings list gives them, because those three words appear uppercase in
 * ordinary shouting too.
 */
const SEVERITY_LABEL_PATTERN = /\b(?:CRITICAL|BLOCKER)\b|\b(?:HIGH|MEDIUM|LOW)\s*[:)\]—–-]/;
const REVIEW_PROSE_PATTERN =
  /\b(?:finding\s+#?\d+|review (?:found|finding|confirmed)|adversarial review)\b/i;

/**
 * The SIGNAL-grade review shape (stricter than the anchor above): every
 * severity — CRITICAL and BLOCKER included — must carry the punctuation a
 * findings list gives it, AND a review-context word must stand nearby.
 * "It is CRITICAL that we not forget the backup" is emphasis; "HIGH: fix
 * the login button tomorrow" is a todo; "Finding 3 (HIGH): the cap is never
 * re-checked" is the modal review output trial finding #12 lost, and the v1
 * gate stayed silent on it whenever the prose skipped verdict vocabulary.
 */
const PUNCTUATED_SEVERITY_PATTERN =
  /\b(?:CRITICAL|BLOCKER|HIGH|MEDIUM|LOW)\s*[:)\]—–-]/;
const REVIEW_CONTEXT_PATTERN = /\b(?:review|finding|findings|audit)\b/i;

/**
 * The green half of a suite flip, the way runners print it. "0 fail" also
 * matches ERROR_OUTPUT_PATTERN's count-fail form, which is why the flip's
 * red half below demands a STRICTLY POSITIVE count or a thrown-error line
 * — a wholly green run must never provide its own "red".
 */
const GREEN_SUITE_PATTERN =
  /\b0 fail(?:ed|ures)?\b|\ball (?:\d+\s+)?tests? (?:pass(?:ed|ing)?|green)\b|\btests? (?:are |is )?(?:passing|green)(?: now)?\b|\bsuite (?:is )?green\b|\bnow (?:passing|green)\b/i;

/**
 * The red half: a positive failure count or failure OUTPUT — a thrown-error
 * line ("TypeError: …", "panic: …") or a Python traceback header. NOT the
 * bare word: "added error handling" beside green tests, and an error class
 * inside a passing test's NAME ("✓ handles TypeError in parser"), each made
 * a wholly green slice read as a flip in v1 (fix-round noise finding
 * HIGH-1), and gate precision is the only thing standing between chatter
 * and the non-refunding cap.
 */
const RED_SUITE_PATTERN =
  /\b[1-9]\d*\s+(?:tests? )?fail(?:ed|ures)?\b|\b\w*(?:error|exception):|\btraceback \(most recent call last\)|\bpanic:/i;

/**
 * A commit, merge or push visible in the slice: the command as it EXECUTES —
 * JSON-rendered tool_use (quote prefix, like TEST_COMMAND_PATTERN), a shell
 * separator, a line start, or a pasted `$ ` prompt — git's own commit
 * summary line (`[branch abc1234] …`), or GitHub's merge phrasing. Bare
 * whitespace is NOT in the prefix class, deliberately: "then git push it
 * once the docs are done" is a plan MENTIONING a command, not a commit that
 * happened, and anchors must attest that work occurred (fix-round noise
 * finding: the v1 prefix class admitted ordinary prose mentions).
 */
const COMMIT_BOUNDARY_PATTERN =
  /(?:^|[;&|("'$])\s{0,2}git\s+(?:commit|merge|push)\b|(?:^|[;&|("'$])\s{0,2}gh\s+pr\s+(?:create|merge)\b|\bmerge pull request\b|\[[^\s[\]]+ [0-9a-f]{7,40}\]/im;

export const hasVerdictLanguage = (text: string): boolean =>
  VERDICT_PATTERN.test(text);

export const hasRejectionLanguage = (text: string): boolean =>
  REJECTION_PATTERN.test(text);

export const hasReviewFindingShape = (text: string): boolean =>
  SEVERITY_LABEL_PATTERN.test(text) || REVIEW_PROSE_PATTERN.test(text);

/**
 * A findings LIST as the conclusion itself: punctuated severity in review
 * context. A review whose entire output is severity labels + defect
 * statements — the modal shape of deep adversarial review tooling — is a
 * conclusion moment with no verdict prose anywhere, and it satisfies the
 * anchor side through hasReviewFindingShape by construction (the signal
 * shapes are a strict subset of the anchor shapes), so the findings list
 * alone fires the gate.
 */
export const hasReviewFindingSignal = (text: string): boolean =>
  PUNCTUATED_SEVERITY_PATTERN.test(text) && REVIEW_CONTEXT_PATTERN.test(text);

/**
 * Red AND green in one slice — something failed and then passed within the
 * turn. The flip is a conclusion SIGNAL in its own right (a fix landed even
 * when nobody wrote "the fix is"), and its red half doubles as the work
 * anchor through hasErrorOutput, so the flip alone fires the gate.
 */
export const hasSuiteFlip = (text: string): boolean =>
  RED_SUITE_PATTERN.test(text) && GREEN_SUITE_PATTERN.test(text);

export const hasCommitBoundary = (text: string): boolean =>
  COMMIT_BOUNDARY_PATTERN.test(text);

/**
 * The conclusion wing's fire condition: a conclusion signal AND a work
 * anchor. Signal alone is planning chatter; anchor alone is a build log.
 */
export const isConclusionMoment = (sliceText: string): boolean =>
  (hasVerdictLanguage(sliceText) ||
    hasRejectionLanguage(sliceText) ||
    hasSuiteFlip(sliceText) ||
    hasReviewFindingSignal(sliceText)) &&
  (hasTestCommand(sliceText) ||
    hasErrorOutput(sliceText) ||
    hasReviewFindingShape(sliceText) ||
    hasCommitBoundary(sliceText));

/** The whole gate's content decision: either wing fires it. */
export const isCaptureMoment = (sliceText: string): boolean =>
  isDiagnosisMoment(sliceText) || isConclusionMoment(sliceText);

/**
 * The gate's budget decision, on the state AFTER this turn was counted:
 * under the hard cap, and at least SUMMARIZER_DEBOUNCE_TURNS Stop turns
 * since the last fire. Pure arithmetic — scripts/mutation-check.ts re-breaks
 * the cap and test/stop-gate.test.ts must go red.
 */
export const summarizerFireAllowed = (state: SessionState): boolean => {
  if (state.summarizerFireCount >= SUMMARIZER_MAX_FIRES_PER_SESSION) {
    return false;
  }
  return (
    state.summarizerLastFireTurn === null ||
    state.stopTurnCount - state.summarizerLastFireTurn >=
      SUMMARIZER_DEBOUNCE_TURNS
  );
};

/** Every Stop invocation counts one turn — fires or not. */
export const withStopTurn = (state: SessionState): SessionState => ({
  ...state,
  stopTurnCount: state.stopTurnCount + 1,
});

/**
 * One fire, recorded against the CURRENT turn: count, debounce anchor, and
 * the token estimate the cost surfaces sum (§10 risk 7 — estimates, and
 * marked as such wherever they are printed).
 */
export const withSummarizerFire = (
  state: SessionState,
  estimatedTokens: number,
): SessionState => ({
  ...state,
  summarizerFireCount: state.summarizerFireCount + 1,
  summarizerLastFireTurn: state.stopTurnCount,
  summarizerEstimatedTokens:
    state.summarizerEstimatedTokens + Math.max(0, estimatedTokens),
});

/**
 * Outcome bookkeeping, recorded by the detached worker once the model has
 * answered (trial finding #12's measuring stick): a NONE, or a draft that
 * actually reached the spool. A run that produced neither — runner failure,
 * unparseable output, or a draft dropped by the echo/secret/contract gates —
 * books nothing, so fires minus NONEs minus drafts stays the honest
 * drop-or-failure remainder on every cost surface.
 */
export const withSummarizerNone = (state: SessionState): SessionState => ({
  ...state,
  summarizerNoneCount: state.summarizerNoneCount + 1,
});

export const withSummarizerDraft = (state: SessionState): SessionState => ({
  ...state,
  summarizerDraftCount: state.summarizerDraftCount + 1,
});

/**
 * An answer the CONNECTOR refused (audit rows M16 / A3-4) — role-play, an
 * echo of the prompt or of a delivered hint, a credential-shaped body, a
 * claim the wire contract would not take. The model spoke and the quota was
 * spent, so this is neither a runner failure nor a NONE nor a draft: it is
 * its own outcome, and booking it is what stops `doctor` reading a session
 * whose every answer was refused as a runner that never spoke.
 *
 * The reason is one of core model/reject.ts's constants — crosscheck's own
 * words, never the rejected body, because it is printed into a terminal and
 * frequently into an agent's context.
 */
export const withSummarizerRejection = (
  state: SessionState,
  reason: string,
): SessionState => ({
  ...state,
  summarizerRejectCount: state.summarizerRejectCount + 1,
  // The same bound and the same surrogate-safe cut the failure reason gets.
  // The reason is one of core model/reject.ts's own constants, so it is never
  // the model's text — but the cut stays, because a writer that trusts its
  // caller is one refactor away from writing an unbounded string into the
  // file every surface reads.
  summarizerLastRejection: cutWellFormed(reason, SUMMARIZER_FAILURE_MAX_CHARS),
});

/**
 * A turn the gate could not even look at: the host produced no slice.
 *
 * ITS OWN OUTCOME, and the distinction is `withGhostNoOverlap`'s, one tier
 * down. A failure means something on THIS machine lost a model call, and the
 * remedy doctor prints for one is the model runner probe. "Cursor sent
 * `transcript_path: null` because this build has transcripts disabled" is a
 * DEPLOYMENT STATE: no model ran, no quota was spent, and the local `claude`
 * binary the remedy would send the reader to is working perfectly. Folded
 * into the failures it would also flip the finding-#14 WARN on a machine
 * where nothing is broken.
 *
 * The reason is the CONNECTOR's own constant, never a host string, and it is
 * bounded here like every other reason this file writes.
 */
export const withSummarizerNoSlice = (
  state: SessionState,
  reason: string,
): SessionState => ({
  ...state,
  summarizerNoSliceCount: state.summarizerNoSliceCount + 1,
  summarizerLastNoSlice: cutWellFormed(reason, SUMMARIZER_FAILURE_MAX_CHARS),
});

/**
 * WHICH DECODER READ THIS TURN'S SLICE — written by a host whose transcript
 * format is undocumented, and by no other.
 *
 * It is not an outcome and it never WARNs: both decoders working is the
 * normal state, and a fallback that matched is a real slice, not a fault. It
 * is a DRIFT TRIPWIRE. The Cursor reader's structured decoder is a hypothesis
 * about a format nobody publishes; if it stops matching, the prose decoder
 * takes over, the gate is handed a strictly weaker slice, and every existing
 * counter stays at zero — a slice was produced, so no noSlice, and no model
 * ran, so no failure. Without this field that flip is invisible on every
 * surface the product has.
 *
 * Bounded like every other string this file writes, though the callers pass a
 * short literal from their own union: a transcript's own bytes never reach a
 * state file through here.
 */
export const withSummarizerSliceShape = (
  state: SessionState,
  shape: string,
): SessionState => ({
  ...state,
  summarizerLastSliceShape: cutWellFormed(shape, SUMMARIZER_FAILURE_MAX_CHARS),
});

/**
 * SLICE CHARACTERS THE HOST'S OWN CAP REFUSED THIS TURN, accumulated.
 *
 * The fourth derive outcome, and the only one that was not booked anywhere a
 * reader could reach: the ACP proxy counted it into a per-pid log file at
 * shutdown and nothing else. Rule 4 (fail-open must never mean silently
 * dead) does not distinguish between a failure and a LOSS — a turn whose
 * conclusion arrived past the cap is judged on its truncated head, the model
 * answers NONE about a turn that did conclude, and every surface reports
 * health.
 *
 * Summed rather than replaced, because the question a reader has is "how much
 * of this session did the gate never see", not "how much did the last turn
 * lose". Zero is the ordinary state and prints nothing.
 */
export const withSummarizerSliceDropped = (
  state: SessionState,
  chars: number,
): SessionState =>
  chars <= 0
    ? state
    : {
        ...state,
        summarizerSliceDroppedChars: state.summarizerSliceDroppedChars + chars,
      };

/**
 * The two sentences an UNREADABLE answer is booked with, in crosscheck's own
 * words. They are the writer's, never the model's: a booked reason is printed
 * by `crosscheck status` and `doctor` into a terminal and frequently into an
 * agent's context, so quoting stdout here would be the one place this product
 * pastes an untrusted model's text into a reader unfiltered.
 *
 * TWO, not one, because the remedies differ. "Printed nothing" points at the
 * wrapper or the model's auth; "printed something unreadable" points at the
 * model's output shape and at the contract in docs/FOREIGN-MODELS.md. A
 * single sentence for both would send half the readers to the wrong place.
 */
export const UNREADABLE_EMPTY =
  "no answer: the binary exited 0 and printed nothing";
export const UNREADABLE_SHAPE =
  "unreadable: the answer was neither claim JSON nor NONE";

/**
 * An answer the model GAVE that this contract could not read (parse.ts
 * readModelAnswer). Its own outcome, and the third time this file has had to
 * make that argument: `withSummarizerFailure` means the RUNNER lost the call
 * and sends the reader to the binary; `withSummarizerNoSlice` means no model
 * ran at all. Here the binary ran, exited 0 and spoke, and what it said did
 * not fit the contract - a MODEL problem, whose remedy is the model or the
 * wrapper in front of it.
 *
 * Until this existed the whole class was booked NOWHERE. That was survivable
 * while the binary was always a Claude whose output shape the prompts were
 * tuned on; it stops being survivable the moment CROSSCHECK_SUMMARIZER_CMD
 * points somewhere else, because then the most likely failure in the product
 * is the one with no counter and no reason (rule 4: fail-open must never mean
 * silently dead).
 */
export const withSummarizerUnreadable = (
  state: SessionState,
  reason: string,
): SessionState => ({
  ...state,
  summarizerUnreadableCount: state.summarizerUnreadableCount + 1,
  summarizerLastUnreadable: cutWellFormed(reason, SUMMARIZER_FAILURE_MAX_CHARS),
});

/**
 * A run that ANSWERED, and whose answer was neither a claim nor NONE (trial
 * finding M5).
 *
 * These used to be booked nowhere. Two of thirty-two live answers were the
 * model addressing the developer rather than the slice — both on `rejection`
 * slices — and they disappeared into the fires-minus-outcomes remainder,
 * where they were indistinguishable from a runner that could not start. The
 * two want opposite fixes (a prompt change versus a machine change), so they
 * get separate counters and the cost line prints both.
 */
export const withSummarizerUnparsed = (state: SessionState): SessionState => ({
  ...state,
  summarizerUnparsedCount: state.summarizerUnparsedCount + 1,
});

/**
 * A run the RUNNER lost (trial finding #14) — binary missing, non-zero
 * exit, deadline — booked by the worker with the reason as
 * runner.ts formatSummarizerFailure renders it. The bound lives HERE, on
 * the writer (SUMMARIZER_FAILURE_MAX_CHARS), never in the schema: one
 * over-long string must not make the state file unparseable. A failure is
 * NOT a NONE and NOT a draft, so the fires-minus-outcomes remainder still
 * counts it; the fail count is what lets status/doctor say WHY the
 * remainder exists instead of leaving it a number.
 */
export const withSummarizerFailure = (
  state: SessionState,
  detail: string,
): SessionState => ({
  ...state,
  summarizerFailCount: state.summarizerFailCount + 1,
  // The same surrogate-safe cut the sanitizer makes (core briefing/cut.ts):
  // a bound in code units that never leaves half an astral character.
  summarizerLastFailure: cutWellFormed(detail, SUMMARIZER_FAILURE_MAX_CHARS),
});
