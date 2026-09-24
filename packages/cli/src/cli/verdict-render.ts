/**
 * The verdict block on `crosscheck suspect` (04 §5).
 *
 * IT PRINTS ABOVE THE FALSIFIER LINES, and that placement is the argument, not
 * a layout choice. `suspect-render.ts` orders its document premise → scope →
 * outcome → rows, because a ranking whose premise is printed underneath it is
 * an accusation with the evidence in a footnote. The verdict is not a
 * conclusion drawn from that premise — it is the LICENCE under which the whole
 * document is to be read: whether anybody may be named at all. A reader who
 * meets the rows first has already read them as an accusation by the time the
 * qualification arrives.
 *
 * EVERY WORD IS RENDERER-OWNED EXCEPT ONE. The hub sends enum values — an
 * attribution, a basis, a protection — and this maps them to sentences, so no
 * hub-chosen prose reaches the terminal. The single exception is the waiver's
 * `reason`, one developer's own sentence about why they opened a fence, and it
 * is framed as the quoted data it is. That makes it the slot 04 §5 requires
 * the injection corpus to attack: a corpus run that plants its payload only in
 * the surface label leaves the one untrusted span on this surface unattacked
 * while the registry still counts it green.
 *
 * WHAT THE CORPUS DOES NOT PROVE, measured rather than assumed. Planting the
 * payload in the reason slot buys the CHARACTER invariants over it — invisible
 * categories, zero-width marks, plane 14, the bounds, the notice, at most one
 * « » pair per line. It does NOT prove the reason is inside a frame at all:
 * the corpus reads the finished string and cannot know which span was
 * untrusted, so replacing `quotedBody` here with a bare sanitize leaves all 99
 * registry assertions green. Verified by doing it. The frame on THIS span is
 * therefore pinned by test/verdict-render.test.ts, and a reader who takes
 * `framing: "framed"` to mean "each untrusted value is in guillemets" is
 * reading a document-class claim as a per-span one.
 *
 * AN UNKNOWN WORD IS PRINTED, NEVER GUESSED AT. A hub newer than this binary
 * may name a basis this build has never heard of. The honest rendering is the
 * word itself plus a statement that there is no sentence for it — not silence,
 * which would drop a qualification the hub took the trouble to compute, and
 * not a nearest-match sentence, which would put this renderer's guess on the
 * hub's authority.
 *
 * AND AN ABSENT VERDICT IS SAID OUT LOUD. `null` means the hub did not report
 * one — an older 1.0 hub, or a response this client could not read. Printing
 * nothing there would leave the ranking standing unqualified, which is the
 * defect this whole spec exists to remove: missing evidence must never
 * strengthen a conclusion.
 */
import { formatAge } from "@crosscheck/connector-core/briefing/render.ts";
import { bareUntrusted } from "@crosscheck/connector-core/briefing/sanitize.ts";
import { quotedBody, safeId } from "@crosscheck/connector-core/mcp/render.ts";
import { MAX_WAIVER_REASON_CHARS } from "@crosscheck/schema";
import type { VerdictView } from "@crosscheck/connector-core/http/verdict.ts";

/**
 * What a reader is told when no verdict arrived.
 *
 * It names the CONSEQUENCE, not the cause: "nothing below is qualified" is
 * what a reader has to act on, and it is true whether the hub is old or the
 * answer was unreadable. 08's `NO_AXES_FROM_HUB` spells the same shape.
 */
export const NO_VERDICT_FROM_HUB =
  "no verdict: this hub does not report one, so nothing below is qualified — the rows are sessions that touched these files, not an answer about who broke this.";

/**
 * ONE SENTENCE PER ATTRIBUTION — the answer to "may anybody be named".
 *
 * The words are deliberately not the enum's: `UNATTRIBUTED` and
 * `INDETERMINATE` are one glance apart and opposite in meaning, and the
 * difference — "we looked and nobody is there" against "we cannot tell" — is
 * the entire product. The enum value is printed beside the sentence so a
 * reader grepping for the machine word still finds it.
 */
const ATTRIBUTION_SENTENCE: Readonly<Record<string, string>> = {
  ATTRIBUTED: "a session is named below",
  UNATTRIBUTED: "nobody is named, and the record is complete enough to say so",
  INDETERMINATE:
    "nobody is named, and the record is not complete enough to say who",
};

/**
 * WHY the attribution is what it is.
 *
 * Thirteen, one per `VERDICT_BASES` entry, and the count is checked against
 * the wire vocabulary by test/verdict-render.test.ts — a basis with no
 * sentence would print as an unknown word on a value this build DOES know,
 * which reads to a user as a hub problem when it is a missing line here.
 */
const BASIS_SENTENCE: Readonly<Record<string, string>> = {
  separated: "one session stands clear of the others on the pinned files",
  no_separation: "the top scores are too close to separate",
  no_touch_complete:
    "no session touched these files, and every evidence source was reporting — so whatever changed this did not come through a recorded agent session",
  coverage_gap:
    "the archive has a gap over these files, so an absence of sessions is not evidence of an absence of work",
  pin_paths_missing:
    "at least one pinned path is gone from git, so a zero here is about the pin rather than about anybody",
  falsifier_absent:
    "nobody has recorded running this pin's check and watching it fail, so there is no break to attribute",
  no_check_recipe:
    "this pin carries no check anybody can run, so nothing here can be falsified",
  attribution_withheld_by_team:
    "this team's setting prints counts only, so no session is named",
  delta_flaky:
    "the behaviour change did not reproduce, and a flaky signal attributes nothing",
  delta_unconfirmed: "the behaviour change was never confirmed against a base",
  ci_no_surface:
    "a CI regression was confirmed, but it names no pinned surface and no files a reader asked about",
  reader_named: "the scope is the files you named, not a pin",
  legality_violation:
    "this verdict combined dimensions that may not be combined, and was withheld rather than shown",
};

/**
 * The protection axis — orthogonal to attribution, and printed as such.
 *
 * `unprotected` prints NOTHING: a line saying "this behaviour is not
 * human-verified" on every ordinary surface would train a reader to skip it,
 * and the one time it says PROTECTED CONFLICT is the time it must be read.
 * `protected_ok` does print, because a lifted fence is a decision somebody
 * made and is owed a reader.
 */
const PROTECTION_SENTENCE: Readonly<Record<string, string>> = {
  protected_ok:
    "this behaviour is human-verified and recorded broken — a live waiver is holding the fence open",
  PROTECTED_CONFLICT:
    "PROTECTED CONFLICT: this behaviour is human-verified and recorded broken, and no waiver covers it",
};

/**
 * A word this build has no sentence for, rendered as a word.
 *
 * `bareUntrusted` rather than raw, because "the hub sends enums" is a contract
 * and not a guarantee: this is still a string off the wire reaching a
 * terminal, and the one branch a renderer must not trust its own layering in
 * is the branch that exists because the value was unexpected.
 */
const unknownWord = (axis: string, value: string): string =>
  `${axis} ${bareUntrusted(value)} (this crosscheck has no sentence for that word — the hub may be newer than this install)`;

const sentenceFor = (
  map: Readonly<Record<string, string>>,
  axis: string,
  value: string,
): string => map[value] ?? unknownWord(axis, value);

/** How long until an expiry, in the reader's terms rather than in seconds. */
const untilOf = (iso: string, now: Date): string => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms)
    ? "an unreadable time"
    : formatAge(Math.max(0, ms - now.getTime()));
};

/**
 * The fence line, and the one framed span on this surface.
 *
 * IT NAMES THE PERSON AND THE DEADLINE BEFORE THE REASON. A waiver is a
 * permission somebody took responsibility for, and a reader shown the
 * justification first is being asked to evaluate an argument rather than told
 * who made a call and until when.
 *
 * THE REASON IS A BODY, NOT A LABEL — `quotedBody`, the class rule of audit
 * row M14. `quoted` blanks the whole value when the phrase filter matches,
 * which is right for a name and wrong where the value IS the answer: "why is
 * this fence open" is exactly that, and a blanked reason would read as a
 * waiver granted for no stated cause.
 */
const waiverLines = (verdict: VerdictView, now: Date): readonly string[] => {
  const waiver = verdict.waiver;
  if (waiver === null) {
    return [];
  }
  const granter =
    waiver.grantedByName === ""
      ? "a developer this hub did not name"
      : bareUntrusted(waiver.grantedByName);
  // One « » pair on its own line: "a line opens the frame at most once".
  const reason =
    waiver.reason === ""
      ? "no reason recorded"
      : quotedBody(waiver.reason, MAX_WAIVER_REASON_CHARS);
  return [
    `  fence opened by ${granter}, expires ${waiver.expiresAt} (in ${untilOf(waiver.expiresAt, now)})`,
    `  their reason: ${reason}`,
  ];
};

const invariantLines = (verdict: VerdictView): readonly string[] =>
  verdict.invariant === null
    ? []
    : [
        `  invariant: pin ${safeId(verdict.invariant.pinId)} at version ${String(verdict.invariant.version)}`,
      ];

const protectionLines = (
  verdict: VerdictView,
  now: Date,
): readonly string[] => {
  const sentence = PROTECTION_SENTENCE[verdict.protection];
  if (sentence === undefined) {
    // `unprotected` is the silent one BY DESIGN and is not an unknown word, so
    // it must not reach the unknown-word branch and make an ordinary surface
    // warn that this install is out of date.
    return verdict.protection === "unprotected"
      ? []
      : [`  ${unknownWord("protection", verdict.protection)}`];
  }
  return [`  ${sentence}`, ...waiverLines(verdict, now)];
};

/**
 * The block, as lines, for embedding in a document that already carries the
 * quoted-data notice. The registered corpus surface wraps these in
 * `quotingText`, which is the one place the notice is added.
 */
export const verdictLines = (
  verdict: VerdictView | null,
  now: Date,
): readonly string[] =>
  verdict === null
    ? [NO_VERDICT_FROM_HUB]
    : [
        `verdict: ${bareUntrusted(verdict.attribution)} — ${sentenceFor(ATTRIBUTION_SENTENCE, "attribution", verdict.attribution)}.`,
        `  because: ${sentenceFor(BASIS_SENTENCE, "basis", verdict.basis)}.`,
        ...invariantLines(verdict),
        ...protectionLines(verdict, now),
      ];

/**
 * Exported for the meta-test that pins one sentence per known basis. Not a
 * render path: nothing prints this map.
 */
export const KNOWN_BASES: readonly string[] = Object.keys(BASIS_SENTENCE);
