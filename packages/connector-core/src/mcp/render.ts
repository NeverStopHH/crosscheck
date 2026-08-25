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
  MAX_DIAGNOSIS_CHARS,
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
 * The same frame, for text whose BODY is the answer rather than a label.
 *
 * `quoted` above blanks the whole value when the phrase filter matches, which
 * is right for a title and wrong for a hub refusal: there the value is the
 * reason and the next call, so blanking it leaves the reader with a redaction
 * marker instead of an address. Everything else is identical — the same clean,
 * the same cap, the same « » — only the phrase branch is narrowed to the span
 * it matched (briefing/sanitize.ts states the trade and who else may use it).
 */
const quotedSpanRedacted = (raw: string, maxChars: number): string =>
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

const claimLine = (
  claim: DiagnosisClaim,
  index: ReadonlyMap<string, string>,
): string => {
  const evidence =
    claim.evidenceRefs.length === 0
      ? ""
      : ` · evidence ${claim.evidenceRefs.map(safeId).join(", ")}`;
  const seen = claim.dedupCount > 1 ? ` · seen ${String(claim.dedupCount)}×` : "";
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
  ];
  return `${facts.join(" · ")}${evidence}${seen}: ${quoted(claim.body, MAX_CLAIM_BODY_LENGTH)}`;
};

const edgeLine = (
  edge: DiagnosisEdge,
  index: ReadonlyMap<string, string>,
): string => {
  const note =
    edge.note === null || edge.note === undefined || edge.note.length === 0
      ? ""
      : `: ${quoted(edge.note)}`;
  return `- ${safeId(edge.fromClaimId)} ${bare(edge.kind)} ${safeId(edge.toClaimId)} · by ${authorLabel(index, edge.authorSessionId)}${note}`;
};

const externalLine = (ref: ExternalClaimRef): string =>
  `- ${safeId(ref.id)} · ${bare(ref.kind)} · in work context ${safeId(ref.workContextId)}`;

export interface Section {
  readonly header: string;
  readonly lines: readonly string[];
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
 */
export const appendSection = (
  accumulated: readonly string[],
  section: Section,
  cap: number,
): readonly string[] => {
  if (section.lines.length === 0) {
    return accumulated;
  }
  const withHeader = [...accumulated, section.header];
  // +1 for the newline the line would arrive on.
  const reserve = moreLine(section.total, section.noun).length + 1;
  if (joinedLength(withHeader) + reserve > cap) {
    return accumulated;
  }
  const lineCap = cap - reserve;
  const fitted = section.lines.reduce<readonly string[]>((lines, line) => {
    const candidate = [...lines, line];
    return joinedLength(candidate) > lineCap ? lines : candidate;
  }, withHeader);
  const shown = fitted.length - withHeader.length;
  const hidden = section.total - shown;
  return hidden <= 0
    ? fitted
    : [...fitted, moreLine(hidden, section.noun)];
};

export const countHeader = (label: string, total: number): string =>
  `${label} (${String(total)}):`;

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
];

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
 */
export interface SolvedPresentation {
  readonly now: Date;
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
  presentation: SolvedPresentation | undefined,
): readonly string[] => {
  if (presentation === undefined) {
    return [];
  }
  const solvedAtMs = solvedAtFromTree(diagnosis);
  if (solvedAtMs === null) {
    return [];
  }
  const age = formatSolvedAge(
    Math.max(0, presentation.now.getTime() - solvedAtMs),
  );
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
 */
export const renderDiagnosis = (
  diagnosis: Diagnosis,
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
  const solvedLines = solvedBlock(diagnosis, solvedPresentation);

  const opening =
    diagnosis.claims.length === 0
      ? [header, contextLine, ...intentLines, ...solvedLines, "Claims: no claims recorded yet."]
      : [header, contextLine, ...intentLines, ...solvedLines];

  const sections: readonly Section[] = [
    {
      header: countHeader("Claims", diagnosis.claims.length),
      lines: diagnosis.claims.map((claim) => claimLine(claim, index)),
      total: diagnosis.claims.length,
      noun: "claim",
    },
    {
      header: countHeader("Edges", diagnosis.edges.length),
      lines: diagnosis.edges.map((edge) => edgeLine(edge, index)),
      total: diagnosis.edges.length,
      noun: "edge",
    },
    {
      header: countHeader(
        "Claims in other work contexts referenced here",
        diagnosis.externalClaims.length,
      ),
      lines: diagnosis.externalClaims.map(externalLine),
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
  const notesReserve = notes.length === 0 ? 0 : joinedLength(notes) + 1;
  const body = sections.reduce<readonly string[]>(
    (lines, section) =>
      appendSection(lines, section, MAX_DIAGNOSIS_CHARS - notesReserve),
    opening,
  );
  return [...body, ...notes].join("\n");
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
  const from = name.length === 0 ? "" : ` from ${name}`;
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
    `The hub said: ${quotedSpanRedacted(hubMessage, MAX_HUB_MESSAGE_CHARS)}`,
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
      lines: hits.map(searchLine),
      total: hits.length,
      noun: "work context",
    },
    MAX_SEARCH_CHARS,
  );
  return lines.join("\n");
};
