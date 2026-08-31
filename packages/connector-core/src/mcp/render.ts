/**
 * Rendering for the two MCP tools that put OTHER developers' text into the
 * reader's agent context.
 *
 * THIS IS THE SAME THREAT AS THE BRIEFING, so it gets the same defences, taken
 * from the same modules rather than written again:
 *
 *   - `sanitizeUntrusted` (briefing/sanitize.ts) for every author-supplied
 *     string — NFKC, control/format/zero-width stripping, removal of the
 *     characters this renderer owns, a width cap, the phrase filter;
 *   - the « » quote frame around each of those strings;
 *   - `QUOTED_DATA_NOTICE` (briefing/render.ts) as the document's first line,
 *     naming the quoted text as data rather than instruction.
 *
 * The third one is imported, not re-typed. Two copies of that sentence would be
 * two things to weaken and only one of them would be covered by the mutation
 * that guards the frame (scripts/mutation-check.ts).
 *
 * WHAT IS NOT FRAMED, AND WHY. Ids are printed bare, because an agent has to
 * pass them back into `get_diagnosis` and `extend_diagnosis` — an id inside « »
 * would arrive back with the guillemets attached. They are still untrusted, and
 * `safeId` (briefing/sanitize.ts, re-exported below) is what makes printing
 * them bare safe: it is an allowlist, so it is strictly narrower than the
 * sanitizer rather than a second, weaker copy of it.
 */
import { MAX_CLAIM_BODY_LENGTH } from "@crosscheck/schema";

import {
  HUB_MAX_DIAGNOSIS_TARGETS,
  MAX_DIAGNOSIS_CHARS,
  MAX_DIAGNOSIS_TARGETS_SHOWN,
  MAX_HUB_MESSAGE_CHARS,
  MAX_SEARCH_CHARS,
  MAX_TITLE_CHARS,
  MAX_WORK_CONTEXT_TITLE_CHARS,
} from "../constants.ts";
import { renderIntent } from "../briefing/intent.ts";
import {
  QUOTED_DATA_NOTICE,
  formatAge,
  formatSolvedAge,
} from "../briefing/render.ts";
import {
  bareUntrusted as bare,
  safeId,
  sanitizeUntrusted,
  spanRedactedUntrusted,
} from "../briefing/sanitize.ts";
import type { CommitDrift } from "../git/commit-drift.ts";
import type { SolvedFileDrift } from "../git/solved-staleness.ts";
import type {
  Diagnosis,
  DiagnosisClaim,
  DiagnosisEdge,
  DiagnosisTarget,
  ExternalClaimRef,
  SearchResultEntry,
} from "../http/hub.ts";

/**
 * Author label for a claim whose developer the hub did not name.
 *
 * Deliberately NOT the session id. `authorSessionId` is an opaque `cc_<uuid>`
 * that no reader can turn into a person, and printing it would suggest the
 * attribution is knowable when it is not. Dropping the claim would be worse
 * still — this is a diagnosis, and a silently shorter one is the failure this
 * whole file is trying to avoid.
 */
export const UNNAMED_AUTHOR = "an unnamed teammate";

/**
 * A captured target whose kind AND value both sanitize to nothing — a value
 * built entirely from invisibles or from the characters this renderer owns.
 *
 * Same trade as UNNAMED_AUTHOR: the row is worth less than a real path and
 * far more than a section whose header counts one more row than it shows.
 */
export const UNPRINTABLE_TARGET = "a target with nothing printable in it";

/**
 * The ID class — `safeId`, the allowlist, and `SAFE_ID_PATTERN`, its positive
 * form — lives in briefing/sanitize.ts beside the PROSE and BARE classes since
 * the briefing grew its first bare-id field (the contradiction pointer).
 * Re-exported here because the tools and their tests reach the class through
 * this module, which is still where every character of tool output is made.
 */
export { SAFE_ID_PATTERN, safeId } from "../briefing/sanitize.ts";

/**
 * Author-written prose, sanitized and framed. Empty input still frames.
 *
 * Exported because the TOOLS quote too — a caller's own argument echoed back in
 * a not-found sentence, and a message the hub chose — and the header of this
 * file is only true if there is one place that frames. A second `«${…}»` in
 * tools/ would be a second thing to weaken and only this one is covered by the
 * mutation that guards the frame (scripts/mutation-check.ts).
 */
export const quoted = (
  raw: string,
  maxChars: number = MAX_TITLE_CHARS,
): string => `«${sanitizeUntrusted(raw, maxChars)}»`;

/**
 * The same frame, for text whose BODY is the answer rather than a label — the
 * class rule of audit row M14.
 *
 * `quoted` above blanks the whole value when the phrase filter matches, which
 * is right for a LABEL (a title is a name for something, and a name that reads
 * like an instruction is worth losing) and wrong wherever the value IS the
 * answer: a hub refusal, whose payload is the reason and the next call; a
 * recorded root cause; a question somebody has to answer. Four of the nine
 * phrase branches are everyday English inside a real finding — `override`,
 * `you must`, `disregard`, `act as` — so blanking handed the reader a
 * redaction marker where the answer should have been, and the AUTHOR never
 * learned it had happened (`redactionNote` in briefing/sanitize.ts is the
 * other half of the row).
 *
 * Everything else is identical: the same clean, the same cap, the same « »,
 * the same quoted-data notice around the document. Only the phrase branch is
 * narrowed to the span it matched, so an attack string is still gone — by the
 * span rather than by the sentence.
 *
 * EXPORTED because the other body surfaces frame too (hints/render.ts,
 * briefing/questions.ts, conference/report.ts): a second `«${…}»` spelling
 * would be a second thing to weaken, exactly as the header says of `quoted`.
 */
export const quotedBody = (raw: string, maxChars: number): string =>
  `«${spanRedactedUntrusted(raw, maxChars)}»`;

/**
 * A tool's answer that CONTAINS quoted data, as a document rather than a
 * sentence.
 *
 * The notice gets its own line, and that is not cosmetic: the notice itself
 * contains a « » pair, because its whole job is to name the frame. A line
 * carrying both it and a framed value would hold two pairs, and "a line opens
 * the frame at most once" is what makes "the guillemets are the renderer's,
 * never the author's" mean anything — asserted over every surface in
 * test/fixtures/untrusted-invariants.ts.
 */
export const quotingText = (...sentences: readonly string[]): string =>
  [QUOTED_DATA_NOTICE, ...sentences].join("\n");

/**
 * `bare` — a short field the renderer prints OUTSIDE the frame: a claim's kind
 * and status, a developer's display name — is `bareUntrusted`, imported from
 * briefing/sanitize.ts where its strip list and its limits are stated. It
 * lives there because the briefing's absence lines print author names in the
 * same bare, U+00B7-separated position, and two copies of the strip would be
 * two things to weaken — same rule as QUOTED_DATA_NOTICE in the header above.
 * `bare` is not used for titles: a title lands inside the frame.
 */
export const CONFIDENCE_DECIMALS = 2;

/**
 * Who wrote a record, resolved through the author SESSION.
 *
 * Claims carry the developer name; edges do not, because the wire contract for
 * an edge has never had one. Rather than widen the hub's response for a label,
 * the edge's author is looked up among the claims of the same tree — an edge
 * into this tree was almost always written by somebody who also wrote a claim in
 * it, and `extend_diagnosis` guarantees exactly that pairing.
 */
const authorIndex = (
  claims: readonly DiagnosisClaim[],
): ReadonlyMap<string, string> =>
  new Map(
    claims.flatMap((claim) =>
      claim.authorDeveloperName === undefined
        ? []
        : [[claim.authorSessionId, claim.authorDeveloperName] as const],
    ),
  );

const authorLabel = (
  index: ReadonlyMap<string, string>,
  sessionId: string,
): string => {
  const name = index.get(sessionId);
  const sanitized = name === undefined ? "" : bare(name);
  return sanitized.length === 0 ? UNNAMED_AUTHOR : sanitized;
};

/**
 * When a claim was recorded, parsed once — `null` when the hub's string is
 * not a date this runtime understands.
 *
 * `createdAt` is hub-supplied and only shape-checked (DiagnosisClaimSchema
 * demands a non-empty string, nothing more), so an older or hostile hub can
 * send anything. Null flows through as NO age fragment and as LAST in the
 * order: a guessed age would be a fact this renderer cannot support, and
 * dropping the claim would be the same silent shortening the whole file
 * exists to avoid.
 */
const parsedMs = (iso: string | null | undefined): number | null => {
  if (iso === null || iso === undefined) {
    return null;
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
};

const claimTimeMs = (claim: DiagnosisClaim): number | null =>
  parsedMs(claim.createdAt);

/**
 * An age fragment, or nothing at all — never a guess.
 *
 * A FUTURE INSTANT IS TREATED EXACTLY AS AN UNPARSEABLE ONE. The old form
 * clamped the difference at zero, which turned any timestamp ahead of the
 * reader's clock into a confident "0s ago". That breaks the rule stated on
 * `claimTimeMs`: a guessed age is a fact this renderer cannot support, which
 * is why an unparseable string prints no age. Clamping gave honest silence to
 * the string nobody can read and a confident lie to the one that is merely
 * impossible — and the impossible one is what a skewed clock or a hostile
 * publisher actually produces, since createdAt is client-supplied and
 * unrange-checked. The claim still renders and still sorts; only the age goes.
 */
const ageFragment = (
  ms: number | null,
  now: Date,
  label: string,
): readonly string[] =>
  ms === null || ms > now.getTime()
    ? []
    : [`${label} ${formatAge(now.getTime() - ms)} ago`];

/**
 * OLDEST FIRST, ENFORCED HERE rather than assumed of the hub.
 *
 * The ages on the claim lines are only worth printing if the sequence they
 * describe is the one on the page, and two findings from the same day both
 * read "21d ago" — so what separates them is their POSITION, and the header
 * says which direction that runs. A hub that returned rows in another order
 * (or a hostile one that shuffled them deliberately) would otherwise make
 * the stated ordering a lie the reader cannot detect.
 *
 * Total, so the output is deterministic: parsed instant, then id. Ties on
 * the instant are real — a batch publish stamps several claims the same
 * millisecond — and leaving those to Array#sort's stability would hand the
 * decision back to hub order.
 */
/**
 * The order, stated as far as the data supports and no further.
 *
 * It used to read "oldest first" flat, which is a claim about WHEN THINGS
 * HAPPENED. `createdAt` cannot carry that: ClaimSchema validates the format
 * and nothing else, the hub stores it verbatim, and the claims table has no
 * server-assigned receive column to fall back on. So the instant is whatever
 * each publishing machine's clock said. A teammate 45 minutes fast lands
 * above a colleague who really did find it first, both lines read "1h ago",
 * and nothing on the page reveals the inversion — a reader answering "who
 * found this first" gets the wrong answer with full confidence.
 *
 * The SORT is worth keeping regardless: it is deterministic and better than
 * hub order. Only the sentence had to come down to what it can vouch for.
 * Stamping a received-at instant hub-side and sorting on that is the stronger
 * fix, and it is a wire change rather than a renderer literal.
 */
const CLAIM_ORDER_QUALIFIER = "oldest first by each author's own clock";

const claimsOldestFirst = (
  claims: readonly DiagnosisClaim[],
): readonly DiagnosisClaim[] =>
  [...claims].sort((left, right) => {
    const leftMs = claimTimeMs(left);
    const rightMs = claimTimeMs(right);
    if (leftMs === null || rightMs === null) {
      // Undatable rows sort last, together, and among themselves by id.
      if (leftMs !== null) {
        return -1;
      }
      if (rightMs !== null) {
        return 1;
      }
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    }
    if (leftMs !== rightMs) {
      return leftMs - rightMs;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });

const claimLine = (
  claim: DiagnosisClaim,
  index: ReadonlyMap<string, string>,
  now: Date,
): string => {
  const evidence =
    claim.evidenceRefs.length === 0
      ? ""
      : ` · evidence ${claim.evidenceRefs.map(safeId).join(", ")}`;
  const seen = claim.dedupCount > 1 ? ` · seen ${String(claim.dedupCount)}×` : "";
  // WHEN THIS FINDING WAS RECORDED, in the vocabulary every other surface
  // already uses (`formatAge`, as searchLine and the hints print it). A
  // second time vocabulary on the one document that shows a whole tree would
  // make two lines about the same instant read as two different facts.
  //
  // "FIRST SEEN", NOT A BARE AGE. On a dedupe hit the hub bumps dedup_count
  // and lastSeenAt and leaves created_at alone, so an unlabelled age sitting
  // beside "seen 4×" reads as latest activity and is the opposite: a finding
  // re-observed an hour ago printed as three months old, at the top of a
  // section headed oldest first.
  const age = ageFragment(claimTimeMs(claim), now, "first seen");
  // The second instant, only when there IS one — a claim seen once has no
  // re-observation, and an older hub sends no field at all.
  const lastSeen =
    claim.dedupCount > 1
      ? ageFragment(parsedMs(claim.lastSeenAt), now, "last seen")
      : [];
  const facts = [
    `- ${safeId(claim.id)}`,
    bare(claim.kind),
    `status ${bare(claim.status)}`,
    `confidence ${claim.confidence.toFixed(CONFIDENCE_DECIMALS)}`,
    // Trust label (DESIGN.md §4), bare like kind and status: §3 sanctions
    // derived drafts on this deliberate pull, so the reader must be able to
    // tell one from a human-vouched declared claim.
    `provenance ${bare(claim.provenance)}`,
    authorLabel(index, claim.authorSessionId),
    ...age,
    ...lastSeen,
  ];
  return `${facts.join(" · ")}${evidence}${seen}: ${quotedBody(claim.body, MAX_CLAIM_BODY_LENGTH)}`;
};

const edgeLine = (
  edge: DiagnosisEdge,
  index: ReadonlyMap<string, string>,
): string => {
  const note =
    edge.note === null || edge.note === undefined || edge.note.length === 0
      ? ""
      : `: ${quotedBody(edge.note, MAX_TITLE_CHARS)}`;
  return `- ${safeId(edge.fromClaimId)} ${bare(edge.kind)} ${safeId(edge.toClaimId)} · by ${authorLabel(index, edge.authorSessionId)}${note}`;
};

const externalLine = (ref: ExternalClaimRef): string =>
  `- ${safeId(ref.id)} · ${bare(ref.kind)} · in work context ${safeId(ref.workContextId)}`;

/**
 * One captured target — WHERE this investigation happened.
 *
 * BARE, NOT FRAMED, and at the width the tripwire already prints a file path
 * (`bare(repoRelativeFile, MAX_WORK_CONTEXT_TITLE_CHARS)`, hints/render.ts).
 * A path is not prose: the reader's next move is to open it or grep for it,
 * and guillemets around `src/auth/refresh.ts` would travel with every copy of
 * it. `bare` is what makes printing it outside the frame safe — it strips the
 * characters this renderer uses as structure, so a target cannot mint a
 * second field or a second line, which is the only thing an unframed value
 * could otherwise do here.
 *
 * NO SEPARATOR BETWEEN KIND AND VALUE, deliberately: ` · ` is the renderer's
 * field separator on every other line of this document, and one more use of
 * it on a line whose second half is a path is one more thing a path could
 * imitate. A space reads the same and forges nothing.
 */


/**
 * Said out loud when the token on the page is not the token the hub holds.
 *
 * The reader's next move with a target is to grep for it or paste it into
 * `search_related_work`. A value this renderer quietly altered fails that and
 * looks like an absence of overlap — `sha256:9f2b…` printed as `sha2569f2b…`
 * matches nothing, and nothing on the line explains why. `formatSolvedLine`
 * already set the precedent for a row this renderer will not vouch for; this
 * is the cheaper half of it, keeping the row and naming the reduction.
 */
export const TARGET_VALUE_REDUCED = " (value reduced for display)";

/**
 * A target's value, reduced as little as printing it safely allows.
 *
 * SPAN-REDACTED FIRST, THEN STRIPPED BARE, and the order is the fix. `bare`
 * alone runs `sanitizeUntrusted`, which is the LABEL class: one phrase match
 * anywhere blanks the WHOLE value. INJECTION_BRANCHES carries bare substrings
 * with no word boundaries, so `src/theme/overrides.ts` — an ordinary file, in
 * a list captured automatically, with no author to warn — rendered as
 * "[redacted: title looked like an instruction]" and the reader lost the one
 * fact the section exists to give them. Span-redacting first replaces the
 * offending run and leaves the directory and the extension, and it also means
 * no phrase survives for the `bare` pass to blank on.
 *
 * The bare strip still runs, because it is what stops a value minting a
 * second field or a second line; what it removes is now visible, via
 * TARGET_VALUE_REDUCED.
 */
const targetValue = (raw: string): string =>
  bare(
    spanRedactedUntrusted(raw, MAX_WORK_CONTEXT_TITLE_CHARS),
    MAX_WORK_CONTEXT_TITLE_CHARS,
  );
const targetLine = (target: DiagnosisTarget): string => {
  const value = targetValue(target.value);
  const parts = [bare(target.kind), value].filter((part) => part.length > 0);
  // A row whose every field sanitized away still renders, for the same reason
  // UNNAMED_AUTHOR does above: the alternative is a section that is quietly
  // one row shorter than the count in its own header.
  const body = parts.length === 0 ? UNPRINTABLE_TARGET : parts.join(" ");
  const note = value === target.value ? "" : TARGET_VALUE_REDUCED;
  return `- ${body}${note}`;
};

export interface Section {
  readonly header: string;
  /**
   * The rows, AS THUNKS rather than as strings.
   *
   * Building a row is not free — a claim row sanitises a whole body, and at
   * MAX_CLAIM_BODY_LENGTH that is the dominant cost of rendering the document
   * (measured on `appendSection` below). A materialised array pays for every
   * row the hub sent; a thunk array pays only for the rows the fitter
   * actually tries, which on a saturated tree is a handful rather than five
   * hundred.
   *
   * It is also what makes the fitter's stop-at-the-first-miss rule cheap: the
   * rows past the cut are never built at all.
   */
  readonly rows: readonly (() => string)[];
  /** What the section WOULD have shown, so a drop can be counted honestly. */
  readonly total: number;
  /** Noun for the "(+N … not shown)" line: "claim", "edge", … */
  readonly noun: string;
}

const joinedLength = (lines: readonly string[]): number =>
  lines.length === 0 ? 0 : lines.join("\n").length;

const moreLine = (count: number, noun: string): string =>
  `(+${String(count)} ${noun}${count === 1 ? "" : "s"} not shown)`;

/**
 * What a section needs held back so it can at least SAY what it hid — the
 * "(+N not shown)" line plus the newline it arrives on. Zero for a section
 * with no rows, which prints nothing and admits nothing.
 */
const sectionReserve = (section: Section): number =>
  section.rows.length === 0 ? 0 : moreLine(section.total, section.noun).length + 1;

/**
 * Appends a section only as far as the budget allows, then says what it left
 * out. Same shape as the briefing's `appendSection`, and same reason: a reader
 * must never be handed a tree that looks whole and is not.
 *
 * THE "(+N NOT SHOWN)" LINE IS PAID FOR FIRST. Spending the budget on content
 * and appending the count only if something is left over gets the priority
 * backwards: the line that says the list is incomplete is worth more than the
 * last item of the list, and a version that appends it "while it fits" drops it
 * exactly when it is needed most — the fuller the section, the likelier the
 * shortfall. `section.total` is the upper bound on `hidden`, and `moreLine` is
 * monotonic in its count, so reserving for the total guarantees the real line
 * fits and costs at most one item that would otherwise have been shown.
 *
 * IT STOPS AT THE FIRST ROW THAT DOES NOT FIT, and that is a correctness rule
 * before it is a performance one. The old form SKIPPED a row it could not
 * afford and kept trying the ones after it. While every body was 400
 * characters that was invisible, because all the rows were about the same
 * width and a shortfall really was a tail drop. Raising the cap to
 * MAX_CLAIM_BODY_LENGTH made the rows differ by 25x, and skipping then means
 * a LONG finding — therefore probably the substantive one — vanishes out of
 * the MIDDLE while every shorter, newer one after it is kept. Nothing on the
 * page marks that: the header promises "oldest first", the ids are opaque,
 * and the "(+N not shown)" line sits at the bottom, so a hole in the
 * discovery sequence reads as a complete prefix. Stopping makes what the
 * reader sees an unbroken PREFIX of the order the header names, which is the
 * only shape the "(+N not shown)" line can honestly describe.
 * `test/mcp-render.test.ts` holds it: "drops the claims AFTER the one that
 * does not fit, never the one itself".
 *
 * A SECTION THAT CANNOT AFFORD ITS HEADER STILL SAYS WHAT IT HID. Returning
 * `accumulated` untouched made a whole section vanish with no header and no
 * count — byte-indistinguishable from a tree that has no such rows at all,
 * which for the external-references section means the reader concludes this
 * investigation links to no other work context. The reserve for that line was
 * already computed one branch above, so the honest form spends the budget the
 * code had set aside rather than new budget.
 *
 * WHAT THE ROWS COST, RE-MEASURED AT THE NEW CAP. An earlier note here quoted
 * "min 8.9 p50 9.2 max 10.4 ms" for 500 claims at the full body cap and
 * blamed `joinedLength`'s quadratic re-join. Both halves were wrong: that
 * timing was the 400-char reading, and the quadratic re-join is a couple of
 * percent of the work. The cost was one `spanRedactedUntrusted` per claim,
 * paid eagerly by materialising every row so the fitter could print four of
 * them. `Section.rows` is thunks for that reason, and the numbers below are
 * this file's own, taken through renderDiagnosis with 500 claims (the hub's
 * DIAGNOSIS_MAX_CLAIMS) each at MAX_CLAIM_BODY_LENGTH.
 *
 * VERIFY: bun run packages/connector-core/scripts/measure-diagnosis-render.ts --check
 * PRINTS: eager-vs-lazy speedup >= 2x: true
 * PRINTS: lazy p50 under 25 ms: true
 *
 * A reading from one host on one day, like every other timing in this repo;
 * the script prints the raw milliseconds without --check. The ratio threshold
 * is 2 and not the 28.8x this machine measures, because the first version
 * pinned 5 and a shared CI runner printed false: at a 0.2 ms denominator the
 * ratio measures the runner's scheduler, not this file. Two still fails hard
 * on the defect it guards — materialising every row scores about 1x.
 */
export const appendSection = (
  accumulated: readonly string[],
  section: Section,
  cap: number,
): readonly string[] => {
  if (section.rows.length === 0) {
    return accumulated;
  }
  const withHeader = [...accumulated, section.header];
  // +1 for the newline the line would arrive on.
  const more = moreLine(section.total, section.noun);
  const reserve = more.length + 1;
  if (joinedLength(withHeader) + reserve > cap) {
    // No room for the header. Say the rows exist anyway, if even that fits —
    // a silent section is the one outcome this function may not produce.
    const withMore = [...accumulated, more];
    return joinedLength(withMore) > cap ? accumulated : withMore;
  }
  const lineCap = cap - reserve;
  // Reassignment of a local binding to a NEW array each step, never mutation
  // of one — the loop exists only so the first miss can stop the walk, which
  // a reduce cannot do and which is what keeps the unbuilt rows unbuilt.
  let fitted: readonly string[] = withHeader;
  for (const row of section.rows) {
    const candidate = [...fitted, row()];
    if (joinedLength(candidate) > lineCap) {
      break;
    }
    fitted = candidate;
  }
  const shown = fitted.length - withHeader.length;
  const hidden = section.total - shown;
  return hidden <= 0 ? fitted : [...fitted, moreLine(hidden, section.noun)];
};

/**
 * A section header carrying its own count, and — where the order of the rows
 * is part of what they say — the order.
 *
 * The qualifier is a renderer-owned literal by construction: the only caller
 * that passes one passes "oldest first", beside the sort that makes it true.
 */
export const countHeader = (
  label: string,
  total: number,
  ordering?: string,
): string =>
  ordering === undefined
    ? `${label} (${String(total)}):`
    : `${label} (${String(total)}), ${ordering}:`;

/**
 * Notes about the completeness of what was just rendered.
 *
 * Both are degraded states, and neither may be silent: `truncated` is the hub
 * refusing to send the whole tree, `droppedRows` is this client refusing to
 * parse part of what it did send.
 */
const completenessNotes = (diagnosis: Diagnosis): readonly string[] => [
  ...(diagnosis.truncated
    ? [
        "Note: the hub truncated this tree at its own bound, so it is partial.",
      ]
    : []),
  ...(diagnosis.droppedRows > 0
    ? [
        `Note: ${String(diagnosis.droppedRows)} rows the hub sent could not be read and were dropped.`,
      ]
    : []),
  // The hub's own target LIMIT is silent — a full page looks exactly like a
  // complete one on the wire — so a client that mirrors the constant is the
  // only thing that can say it. A NOTE rather than a line of the section,
  // because it is a statement about completeness and the notes are the one
  // thing this document pays for before any row of any section.
  // Measured against what the hub SENT, not against what survived parsing: a
  // full page with one unreadable row is still a full page, and dropping the
  // note there loses it exactly when the tree is fullest.
  ...(diagnosis.targets.length + diagnosis.droppedTargets >=
  HUB_MAX_DIAGNOSIS_TARGETS
    ? [
        "Note: the hub returned as many targets as it will send, so more may exist.",
      ]
    : []),
];

/**
 * The three honest states of the targets block, as ONE line each for the two
 * that have nothing to list.
 *
 * A hub that never answered and a work context nothing was captured on are
 * different facts, and only one of them says anything about the code. Folding
 * them into a shared "no files touched" would be the lie a reader cannot
 * detect: they would conclude their edit overlaps nobody.
 */
/** The as-of the targets section can honestly carry; see its call site. */
const TARGETS_AS_OF = "as captured during this work";

/**
 * Past this many characters the document restates its quoted-data frame at
 * the foot; see `renderDiagnosis`.
 *
 * Set at the OLD document cap, which is the length the single opening notice
 * was actually sized against — so nothing that fitted before gains a second
 * line, and everything the raise made newly possible gets one.
 *
 * VERIFY: bun -e 'const c=await import("./packages/connector-core/src/constants.ts");const r=await import("./packages/connector-core/src/mcp/render.ts");console.log(r.DIAGNOSIS_RESTATE_NOTICE_OVER < c.MAX_DIAGNOSIS_CHARS)'
 * PRINTS: true
 */
export const DIAGNOSIS_RESTATE_NOTICE_OVER = 12_000;

const TARGETS_UNREPORTED =
  "This hub does not report captured targets.";
const TARGETS_EMPTY =
  "No targets were captured for this work context.";

/**
 * The FOURTH state: the hub answered, and this client could not read what it
 * said. Distinct from both silences above, because it is the only one of the
 * three that is this client's fault — and the only one where a reader who
 * acted on "no overlap" would be acting on a parse failure.
 */
const targetsUnreadable = (dropped: number): string =>
  `The hub sent ${String(dropped)} target row${dropped === 1 ? "" : "s"} this client could not read.`;

const targetsStateLines = (diagnosis: Diagnosis): readonly string[] => {
  if (!diagnosis.targetsReported) {
    return [TARGETS_UNREPORTED];
  }
  if (diagnosis.targets.length > 0) {
    return [];
  }
  return diagnosis.droppedTargets > 0
    ? [targetsUnreadable(diagnosis.droppedTargets)]
    : [TARGETS_EMPTY];
};

/** Same-author revision edge; its TARGET is the retracted claim. */
const SUPERSEDES_EDGE_KIND = "supersedes";

/**
 * Disagreement edge: two QUALIFYING root causes joined by one are the
 * referee-mode deadlock (DESIGN.md §4), a live dispute — not settled.
 */
const CONTRADICTS_EDGE_KIND = "contradicts";

/** The one claim status that can mark a tree solved. */
const SOLVED_CLAIM_STATUS = "likely_root_cause";

/**
 * Only vouched-for rows can settle a tree — positive equality, fail closed
 * on unknown strings, the hint selector's isDeclared rule applied to the
 * solved label (and the hub's DECLARED_PROVENANCE, services/similarity-gate.ts).
 */
const SOLVED_CLAIM_PROVENANCE = "declared";

/**
 * When this tree was SOLVED — the newest DECLARED likely_root_cause claim
 * WITH evidence refs that is neither superseded nor deadlocked — or null.
 *
 * Derived from the VERY TREE being rendered, deliberately, rather than
 * shipped as a hub field: the label then cannot disagree with the claims the
 * reader sees under it, and a hostile hub cannot mint "solved" without also
 * minting the claim rows that justify it. This mirrors the hub's own rule
 * (packages/server/src/services/solved.ts — same status, same evidence
 * floor, same declared-provenance gate, same supersedes probe, same deadlock
 * probe); the two sit on opposite sides of the wire where an import cannot
 * reach, so each side's tests pin its half, and an intentional rule change
 * must touch both files.
 *
 * DERIVED ROWS NEVER SOLVE, on either side of a contradicts edge: a
 * machine-derived likely_root_cause is nobody's vouched answer (the same
 * fail-closed `=== "declared"` equality as hint selection), so it cannot
 * earn the label — and cannot deadlock it off a genuinely vouched rival.
 *
 * DEADLOCK: a qualifying root cause loses its standing while a contradicts
 * edge joins it to another QUALIFYING root cause — two standing answers that
 * cannot both be right are a dispute, and a dispute must not read settled.
 * A rival that is evidence-free or superseded does not count: a drive-by
 * theory cannot unsolve a tree.
 *
 * TRUNCATED TREES NEVER READ SOLVED. The hub's caps keep the OLDEST rows,
 * so a late supersedes or contradicts edge — exactly the rows that would
 * DISQUALIFY the solving claim — can be what fell off; a label computed
 * over partial data would vouch too much. Claims-side truncation already
 * failed toward not-solved; the truncated gate makes the edge side fail
 * the same honest direction.
 */
export const solvedAtFromTree = (
  diagnosis: Pick<Diagnosis, "claims" | "edges" | "truncated">,
): number | null => {
  if (diagnosis.truncated) {
    return null;
  }
  const supersededIds = new Set(
    diagnosis.edges
      .filter((edge) => edge.kind === SUPERSEDES_EDGE_KIND)
      .map((edge) => edge.toClaimId),
  );
  const qualifying = diagnosis.claims.filter(
    (claim) =>
      claim.status === SOLVED_CLAIM_STATUS &&
      claim.provenance === SOLVED_CLAIM_PROVENANCE &&
      claim.evidenceRefs.length > 0 &&
      !supersededIds.has(claim.id),
  );
  const qualifyingIds = new Set(qualifying.map((claim) => claim.id));
  const deadlockedIds = new Set(
    diagnosis.edges
      .filter(
        (edge) =>
          edge.kind === CONTRADICTS_EDGE_KIND &&
          qualifyingIds.has(edge.fromClaimId) &&
          qualifyingIds.has(edge.toClaimId),
      )
      .flatMap((edge) => [edge.fromClaimId, edge.toClaimId]),
  );
  const solvedTimes = qualifying
    .filter((claim) => !deadlockedIds.has(claim.id))
    .map((claim) => Date.parse(claim.createdAt))
    .filter((ms) => !Number.isNaN(ms));
  return solvedTimes.length === 0 ? null : Math.max(...solvedTimes);
};

/**
 * What the pull-time git checks learned about a solved tree — computed by
 * the TOOL (only it has a repo to ask) and rendered here. Every field is
 * fail-open: null drift and "unknown" fileDrift render honest absence.
 *
 * IT CARRIES NO CLOCK. It used to hold its own `now`, which was a second
 * clock in a document that now dates every claim line from `renderDiagnosis`'s
 * — two instants that could disagree about the same render. The renderer
 * takes ONE `now` and spends it on both.
 */
export interface SolvedPresentation {
  readonly drift: CommitDrift | null;
  readonly fileDrift: SolvedFileDrift;
}

/** DESIGN.md §4's drift phrasing, against the READER's HEAD. */
const diagnosisDriftLine = (drift: CommitDrift | null): readonly string[] => {
  if (drift === null || (drift.ahead === 0 && drift.behind === 0)) {
    return [];
  }
  return drift.behind > 0
    ? [`The diagnosis is based on a commit ${String(drift.behind)} behind your HEAD.`]
    : [`The diagnosis is based on a commit ${String(drift.ahead)} ahead of your HEAD.`];
};

const FILE_DRIFT_SENTENCES: Readonly<Record<SolvedFileDrift, string>> = {
  changed:
    "Files this diagnosis referenced have changed on the default branch since it was recorded.",
  unchanged:
    "Files this diagnosis referenced have not changed on the default branch since it was recorded.",
  unknown:
    "Whether the files this diagnosis referenced have since changed is unknown.",
};

/**
 * The honest-presentation block for a solved tree (VISION.md §1): age stated
 * plainly, drift where available, staleness in three states, and the
 * lead-not-answer framing. Factual statements only — never imperatives —
 * and every character renderer-built (ages via formatSolvedAge, sentences
 * from this file), so no new untrusted path opens here.
 */
const solvedBlock = (
  diagnosis: Diagnosis,
  now: Date,
  presentation: SolvedPresentation | undefined,
): readonly string[] => {
  if (presentation === undefined) {
    return [];
  }
  const solvedAtMs = solvedAtFromTree(diagnosis);
  if (solvedAtMs === null) {
    return [];
  }
  const age = formatSolvedAge(Math.max(0, now.getTime() - solvedAtMs));
  const landed =
    diagnosis.workContext.landedAt === null ||
    diagnosis.workContext.landedAt === undefined
      ? []
      : ["The owning session's base commit is on the repo's default branch."];
  return [
    `Solved: a root cause claim with recorded evidence was added ${age} ago — ` +
      "an old diagnosis is a recorded lead, not a statement about the current code.",
    ...landed,
    ...diagnosisDriftLine(presentation.drift),
    FILE_DRIFT_SENTENCES[presentation.fileDrift],
  ];
};

/**
 * One diagnosis tree, as markdown-ish text for an agent to read.
 *
 * WHAT IS FRAMED, AND WHAT IS ONLY NARROWED. An earlier version of this comment
 * said "every author-written string arrives inside « »", which was not true of
 * three fields and is the kind of sentence this repo runs a script against.
 *
 *   FRAMED — the work context title, every claim body, every edge note. All the
 *   PROSE, inside « », under a first line saying the quoted text is data.
 *
 *   BARE, ALLOWLISTED — every id, through `safeId`. An agent has to pass them
 *   back into another tool and a guillemet would come back attached.
 *
 *   BARE, NARROWED — a claim's kind and status, and the developer name on the
 *   context line, on every claim line and on every edge line, through `bare`.
 *
 * The third class is the weak one and is documented rather than glossed. `bare`
 * removes the characters this renderer uses as structure, so a display name
 * cannot mint a second status, a second confidence or a second author — that
 * hole was real, and test/mcp-render.test.ts holds it shut. It does NOT make an
 * unframed name instruction-free: a name that reads as a sentence still reaches
 * the reader outside the quotes.
 *
 * FRAMING IT WAS THE OTHER OPTION AND WAS REJECTED. The author label shares a
 * line with the framed body, so framing it would put two « » pairs on that line,
 * and "a line opens the frame at most once" is asserted over BOTH renderers by
 * test/fixtures/untrusted-invariants.ts — the briefing's corpus rests on it too.
 * Weakening an invariant shared by two surfaces to strengthen one field of one
 * of them is the wrong trade, and the residual is bounded: a display name is
 * sanitized, phrase-filtered, capped at MAX_TITLE_CHARS and structurally inert.
 *
 * WHEN, AS WELL AS WHAT. Every claim line carries the age of the claim and the
 * section is sorted oldest first, because the ORDER of discovery is half of
 * what an old tree is worth — "which of these did they find first" is not
 * answerable from a single age for the whole context. `now` is the ONE clock
 * the whole document is read against, so the per-claim ages and the solved
 * block cannot disagree inside one render.
 *
 * THE FITTER STILL DROPS FROM THE TAIL, which under this order means the
 * NEWEST claims — the same direction the hub's own truncation keeps (oldest
 * rows kept, services/diagnosis.ts), so a full tree and a truncated one agree
 * about which end is missing. Whichever end goes, "(+N claims not shown)"
 * counts it.
 */
export const renderDiagnosis = (
  diagnosis: Diagnosis,
  now: Date,
  solvedPresentation?: SolvedPresentation,
): string => {
  const index = authorIndex(diagnosis.claims);
  const context = diagnosis.workContext;
  const header = `crosscheck diagnosis for work context ${safeId(context.id)}. ${QUOTED_DATA_NOTICE}`;
  const contextLine = `Work context ${quoted(context.title, MAX_WORK_CONTEXT_TITLE_CHARS)} · status ${bare(context.status)} · opened by ${authorLabel(index, context.sessionId)}`;
  // The session's stated intent on its own line (trial finding #16): one
  // framed value per line, the one fragment every surface spells.
  const intentFragment = renderIntent(context.intent);
  const intentLines = intentFragment === null ? [] : [`Session ${intentFragment}`];
  const solvedLines = solvedBlock(diagnosis, now, solvedPresentation);
  const claims = claimsOldestFirst(diagnosis.claims);

  const opening =
    diagnosis.claims.length === 0
      ? [
          header,
          contextLine,
          ...intentLines,
          ...solvedLines,
          ...targetsStateLines(diagnosis),
          "Claims: no claims recorded yet.",
        ]
      : [header, contextLine, ...intentLines, ...solvedLines, ...targetsStateLines(diagnosis)];

  const sections: readonly Section[] = [
    // WHERE, BEFORE WHAT. A reader who is about to edit the same file wants
    // the overlap before the reasoning — Nick called the file list "the most
    // direct connection" — and the section is small enough to afford the
    // position: it shows at most MAX_DIAGNOSIS_TARGETS_SHOWN rows, and any
    // claim line it displaces is counted by the claims section's own
    // "(+N claims not shown)".
    {
      // AS CAPTURED, NOT AS TRUE NOW. work_context_targets has no timestamp
      // column, so a path here is undated by construction — and the claim
      // lines below it now carry ages, which makes an unqualified list read
      // as current by contrast. A path renamed a fortnight ago sends the
      // reader to a file that is gone, or to a different file at the same
      // name, and they conclude there is no overlap. The qualifier is a
      // renderer-owned literal and costs no wire change; marking actual
      // drift would mean running checkSolvedFileDrift for open trees too.
      header: countHeader(
        "Targets",
        diagnosis.targets.length,
        TARGETS_AS_OF,
      ),
      rows: diagnosis.targets
        .slice(0, MAX_DIAGNOSIS_TARGETS_SHOWN)
        .map((target) => () => targetLine(target)),
      total: diagnosis.targets.length,
      noun: "target",
    },
    {
      // The ordering is STATED, not implied: the ages alone cannot express
      // it once two findings share a day, and `claimsOldestFirst` is what
      // makes the sentence true against a hub that sent any other order.
      header: countHeader(
        "Claims",
        diagnosis.claims.length,
        CLAIM_ORDER_QUALIFIER,
      ),
      rows: claims.map((claim) => () => claimLine(claim, index, now)),
      total: diagnosis.claims.length,
      noun: "claim",
    },
    {
      header: countHeader("Edges", diagnosis.edges.length),
      rows: diagnosis.edges.map((edge) => () => edgeLine(edge, index)),
      total: diagnosis.edges.length,
      noun: "edge",
    },
    {
      header: countHeader(
        "Claims in other work contexts referenced here",
        diagnosis.externalClaims.length,
      ),
      rows: diagnosis.externalClaims.map((ref) => () => externalLine(ref)),
      total: diagnosis.externalClaims.length,
      noun: "reference",
    },
  ];

  // THE NOTES ARE PAID FOR BEFORE ANY CLAIM LINE IS LAID OUT.
  //
  // They used to be appended last "only while they fit", which reads like care
  // and is the defect: a note saying the tree is partial, dropped because the
  // tree was too full to hold it, is precisely the failure it exists to
  // prevent — and it failed exactly when it mattered, since the fuller the
  // tree, the likelier the shortfall. Sweeping body length 1..400 with 500
  // claims, 258 of the 400 renders lost at least one note. (HISTORICAL: that
  // count was measured against the defective code, which is fixed, so nothing
  // in this tree re-derives it. What IS re-runnable is the same sweep,
  // asserting the opposite: `keeps every completeness note at EVERY body
  // length` in test/mcp-render.test.ts.)
  //
  // So their budget comes off the top, and what gives way instead is a claim
  // line — which is honest, because the "(+N not shown)" line then counts it.
  const notes = completenessNotes(diagnosis);
  // The closing restatement is paid for with the notes, for the same reason:
  // it is a statement ABOUT the document, and a frame that got dropped for
  // length is exactly the failure it exists to prevent.
  const notesReserve =
    joinedLength([...notes, QUOTED_DATA_NOTICE]) + (notes.length === 0 ? 1 : 2);
  // AND EVERY LATER SECTION'S COUNT LINE IS PAID FOR TOO, by the same
  // argument one paragraph up. `appendSection` can keep a section from
  // vanishing in silence only if there is budget left when it is reached, and
  // an earlier section will happily spend the last byte — a busy tree of
  // edges swallowed the external-references section whole, header, count and
  // all. Holding back each remaining section's "(+N not shown)" line costs at
  // most one row of an earlier section, which that section's own count line
  // then reports.
  const body = sections.reduce<readonly string[]>((lines, section, index) => {
    const laterReserve = sections
      .slice(index + 1)
      .reduce((total, later) => total + sectionReserve(later), 0);
    return appendSection(
      lines,
      section,
      MAX_DIAGNOSIS_CHARS - notesReserve - laterReserve,
    );
  }, opening);
  const document = [...body, ...notes].join("\n");
  // THE FRAME IS RESTATED WHEN THE PAGE IS LONG. The notice is one line at
  // the very top, and MAX_DIAGNOSIS_CHARS moved 12,000 -> 48,000 to make room
  // for long findings — so the standing sentence that framed text is DATA now
  // has to hold across four times the span of other people's prose, tens of
  // thousands of characters from where it was said. The sanitizer is not the
  // weak point; the DISTANCE is. A hostile teammate writing a patient
  // instruction block into the tail of a 10,000-character finding needs none
  // of the nine literal phrases, and it lands with the framing far out of
  // sight.
  //
  // A renderer-owned literal, reusing the same constant rather than a second
  // spelling of it, and only past a length where the top line has genuinely
  // scrolled away — a reminder on every document would stop being a signal.
  return document.length <= DIAGNOSIS_RESTATE_NOTICE_OVER
    ? document
    : `${document}\n${QUOTED_DATA_NOTICE}`;
};

/** One work context the hub search matched, with its ages at query time. */
export interface SearchHit {
  readonly entry: SearchResultEntry;
  readonly ageMs: number;
  /** Age of the solving claim, for solved results; the tool computes it. */
  readonly solvedAgeMs?: number | undefined;
}

/**
 * The solved marker (VISION.md §1): strict equality on the wire value, a
 * renderer-built label — the hub's string is never printed, so no fourth
 * untrusted path. Empty for open results and unknown kinds.
 */
const solvedFact = (hit: SearchHit): readonly string[] =>
  hit.entry.resultKind === "solved"
    ? [
        hit.solvedAgeMs === undefined
          ? "solved"
          : `solved (diagnosed ${formatSolvedAge(hit.solvedAgeMs)} ago)`,
      ]
    : [];

const searchLine = (hit: SearchHit): string => {
  const author =
    hit.entry.developerName === undefined ? "" : bare(hit.entry.developerName);
  const facts = [
    `- ${safeId(hit.entry.id)}`,
    author.length === 0 ? UNNAMED_AUTHOR : author,
    `${formatAge(hit.ageMs)} ago`,
    `status ${bare(hit.entry.status)}`,
    ...solvedFact(hit),
  ];
  const line = `${facts.join(" · ")}: ${quoted(hit.entry.title, MAX_WORK_CONTEXT_TITLE_CHARS)}`;
  // The intent on a second, indented line of the SAME section entry (one
  // « » pair per line; appendSection keeps or drops the hit whole).
  const intent = renderIntent(hit.entry.intent);
  return intent === null ? line : `${line}\n  ${intent}`;
};

/**
 * THE QUERY GETS ITS OWN LINE, and that is not cosmetic.
 *
 * The first draft put it in the header, next to QUOTED_DATA_NOTICE — and the
 * notice CONTAINS a « » pair, because its whole job is to name the frame ("Text
 * in « » was written by other developers…"). A header carrying both therefore
 * held two pairs, and the invariant that every line opens the frame at most once
 * is what makes "the guillemets are the renderer's, never the author's" mean
 * anything. With two pairs on one line a reader cannot tell which is the frame.
 *
 * Found by the corpus rather than by reading: mcp-injection.test.ts failed on
 * `ignore-previous/searchId header` with `Expected: <= 1, Received: 2`. The
 * briefing never hit it because its header frames no value at all.
 */
const searchHeader = (): string =>
  `crosscheck work contexts on this repo. ${QUOTED_DATA_NOTICE}`;

const queryLine = (framedQuery: string): string => `Query: ${framedQuery}`;

/**
 * What the hub search IS, in one line — because a model that believes it ran
 * something else will draw conclusions an empty result does not support.
 *
 * Two variants, chosen by what the hub REPORTED it did for this search
 * (`vectorTierActive`), never by what this client hopes is configured: the
 * keyless install has no semantic tier and must say so, and a hub with an
 * embedder must stop denying it.
 */
const SEARCH_METHOD_LEXICAL =
  "Hybrid lexical match — exact file/symbol/fingerprint targets ranked above full-text " +
  "over titles, statuses and claim summaries, this repo only, recent work ranked higher — " +
  "not a semantic search.";
const SEARCH_METHOD_SEMANTIC =
  "Hybrid match — exact file/symbol/fingerprint targets ranked above full-text over " +
  "titles, statuses and claim summaries, plus a semantic similarity tier, this repo only, " +
  "recent work ranked higher.";

/**
 * WHICH FILTERS RAN, as the hub reported them (roadmap R1) — never as this
 * client hopes, the same rule `semanticTier` follows one field above.
 *
 * `sinceAgeMs` is a DURATION, not the instant: the hub sends the resolved
 * timestamp and the tool subtracts its own clock, so the window prints in the
 * vocabulary the rest of the answer already uses — `14d` beside "3d ago" on
 * the hits, and `14d` is also exactly what the caller types into `since`.
 */
export interface SearchFilterView {
  readonly developerName?: string | undefined;
  /**
   * The address, present only when the hub says the display name is shared —
   * see the fragment below for why an answer sometimes has to carry it.
   */
  readonly developerEmail?: string | undefined;
  /** The filter names the READER — see the fragment below for why it shows. */
  readonly isSelf?: boolean | undefined;
  readonly sinceAgeMs?: number | undefined;
}

export interface SearchRenderOptions {
  /** The hub reported its vector tier ran for this search. */
  readonly semanticTier?: boolean;
  readonly filters?: SearchFilterView | undefined;
}

const searchMethodLine = (options: SearchRenderOptions): string =>
  options.semanticTier === true
    ? SEARCH_METHOD_SEMANTIC
    : SEARCH_METHOD_LEXICAL;

/**
 * The developer a filter narrowed to, BARE — a display name, like every other
 * author name on this surface, never a frame of its own.
 *
 * "(you)" is renderer-owned and load-bearing. Search does not exclude the
 * caller (hiding your own tree would make `get_diagnosis` on it unreachable),
 * so `developer: <myself>` is a legitimate call — and its results would
 * otherwise be indistinguishable from a teammate's, which is a misattribution
 * the reader has no way to notice.
 */
const developerFragment = (filters: SearchFilterView): string | null => {
  const name =
    filters.developerName === undefined ? "" : bare(filters.developerName);
  if (name.length === 0) {
    return null;
  }
  const labelled = filters.isSelf === true ? `${name} (you)` : name;
  // THE ADDRESS, WHEN THE NAME IS NOT ENOUGH. The hub sends it exactly when
  // two people share this display name — the same fact its ambiguity refusal
  // is built on — so a caller who was refused, retyped the exact address and
  // got an answer does not read a header that has thrown that away again.
  // BARE like the name: an address is author-written text, not a frame.
  const email =
    filters.developerEmail === undefined ? "" : bare(filters.developerEmail);
  return email.length === 0 ? labelled : `${labelled} · ${email}`;
};

const windowFragment = (filters: SearchFilterView): string | null =>
  filters.sinceAgeMs === undefined
    ? null
    : `active in the last ${formatAge(filters.sinceAgeMs)}`;

const filtersLine = (options: SearchRenderOptions): readonly string[] => {
  const filters = options.filters;
  if (filters === undefined) {
    return [];
  }
  const parts = [developerFragment(filters), windowFragment(filters)].filter(
    (part): part is string => part !== null,
  );
  return parts.length === 0 ? [] : [`Filters: ${parts.join(" · ")}`];
};

/**
 * "Nothing matched" is a different sentence once a filter is in play, and the
 * difference is the whole reason R1 needed care.
 *
 * Unfiltered, an empty result says these WORDS matched nothing. Filtered, it
 * says these words matched nothing FROM THIS PERSON IN THIS WINDOW — and a
 * reader who forgets the second half concludes "Ken has done nothing" and goes
 * off to redo Ken's work. So the filters are repeated in the sentence and the
 * sentence says out loud that they are part of the answer.
 */
const noMatchLine = (options: SearchRenderOptions): string => {
  const filters = options.filters;
  const name =
    filters?.developerName === undefined ? "" : bare(filters.developerName);
  // "you", not the reader's own display name — the same flag and the same
  // reason as the filter line three functions up. Without it one answer
  // carries two lines that disagree about who Nick is, and a model quoting
  // only the sentence reports it as a fact about a teammate called Nick.
  const from =
    name.length === 0
      ? ""
      : filters?.isSelf === true
        ? " from you"
        : ` from ${name}`;
  const window =
    filters?.sinceAgeMs === undefined
      ? ""
      : ` in the last ${formatAge(filters.sinceAgeMs)}`;
  const sentence = `No work context on this repo matched that query${from}${window}.`;
  return from.length === 0 && window.length === 0
    ? sentence
    : `${sentence} Those filters are part of that answer: other words, a longer ` +
        "window or another teammate may well match.";
};

/**
 * A query that could not be searched for at all, as distinct from one that was
 * searched for and missed.
 *
 * The two are different answers and collapsing them is a lie in the direction
 * that costs most: "nothing matched" tells a model its question was ASKED, so it
 * concludes nobody has worked on the problem and goes off to redo the work. This
 * says the question was never asked, and why.
 *
 * NO METHOD LINE HERE, deliberately: nothing was searched, so there is no
 * method to describe — and this client never called the hub, so it cannot know
 * which method sentence would even be true.
 */
export const renderUnusableQuery = (
  query: string,
  minChars: number,
): string => {
  const framedQuery = quoted(query);
  return [
    searchHeader(),
    queryLine(framedQuery),
    `Nothing was searched for: no word in the query is at least ${String(minChars)} ` +
      "characters long, and shorter words are dropped because they carry grammar rather " +
      "than meaning. Ask again with the distinctive words of the problem.",
  ].join("\n");
};

/**
 * A search that never ran because a FILTER did not resolve (roadmap R1).
 *
 * Kept apart from an empty result on purpose, and for the reason
 * `renderUnusableQuery` exists one screen above: collapsing "I could not tell
 * which person you meant" into "nothing matched" tells a model its question
 * was asked and answered, so it concludes the teammate has done nothing. This
 * says the opposite in its first sentence, and hands the hub's own reason
 * over as quoted data — the hub chose those words, so they are framed and
 * capped exactly like a teammate's claim body (mcp/tools/shared.ts states the
 * threat model).
 *
 * NO METHOD LINE, like the unusable-query surface: nothing was searched, so
 * there is no method to describe.
 */
export const renderSearchFilterRefusal = (
  query: string,
  hubMessage: string,
): string =>
  [
    searchHeader(),
    queryLine(quoted(query)),
    "Nothing was searched: a filter did not resolve to what it names, so this is " +
      "not a result about anyone's work.",
    `The hub said: ${quotedBody(hubMessage, MAX_HUB_MESSAGE_CHARS)}`,
  ].join("\n");

/**
 * What each unapplied filter COSTS the answer, said in the answer's own terms.
 *
 * Naming the argument is not enough on its own: "the developer filter did not
 * run" leaves the reader to work out what the rows beside it therefore are, and
 * a reader who does not work that out is the whole failure mode here.
 */
const UNAPPLIED_FILTER_COST: Readonly<Record<string, string>> = {
  developer: "the rows it sent are everyone's work, not one teammate's",
  since: "the rows it sent reach back over all of history, not just the window",
};

/**
 * A search whose FILTERS the hub never applied (roadmap R1).
 *
 * THIS IS THE ONE OMISSION THAT CHANGES THE QUESTION. Every other "an older hub
 * sends no such field" case in http/hub.ts costs a DETAIL — a tier label, a
 * solved marker, an intent — and the answer around it stays true. Here the
 * omitted field is the only evidence that the caller's question was ever asked,
 * and the rows beside it are a true answer to a DIFFERENT one: everybody's work
 * over all of history. Rendered as an ordinary success they read as "here is
 * Ken's work from the last two weeks", which is the misattribution the `(you)`
 * label two screens up exists to prevent in its smaller form.
 *
 * So it is a refusal, on the grounds the two surfaces above it share: a question
 * that was never asked must not come back looking answered. It is NOT framed as
 * "the hub said" — no hub said anything, this client noticed the silence.
 */
export const renderUnappliedFilters = (
  query: string,
  unapplied: readonly string[],
): string => {
  const plural = unapplied.length === 1 ? "" : "s";
  const costs = unapplied
    .map((name) => UNAPPLIED_FILTER_COST[name])
    .filter((cost): cost is string => cost !== undefined)
    .join(", and ");
  return [
    searchHeader(),
    queryLine(quoted(query)),
    "Nothing was searched: this hub did not report applying the " +
      `${unapplied.join(" and ")} filter${plural} this call sent, so ${costs}. ` +
      "A hub older than a filter drops it without saying so, which is why this " +
      `is a refusal rather than a list. Ask again without that filter${plural}, ` +
      "or ask whoever runs the hub to update it.",
  ].join("\n");
};

/**
 * Hub search results, in the hub's fused ranking order.
 */
export const renderSearchResults = (
  hits: readonly SearchHit[],
  query: string,
  options: SearchRenderOptions = {},
): string => {
  const framedQuery = quoted(query);
  const opening = [
    searchHeader(),
    queryLine(framedQuery),
    ...filtersLine(options),
    searchMethodLine(options),
  ];
  if (hits.length === 0) {
    return [...opening, noMatchLine(options)].join("\n");
  }
  const lines = appendSection(
    opening,
    {
      header: countHeader("Work contexts", hits.length),
      rows: hits.map((entry) => () => searchLine(entry)),
      total: hits.length,
      noun: "work context",
    },
    MAX_SEARCH_CHARS,
  );
  return lines.join("\n");
};
