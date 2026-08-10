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
  MAX_SEARCH_CHARS,
  MAX_TITLE_CHARS,
  MAX_WORK_CONTEXT_TITLE_CHARS,
} from "../constants.ts";
import { QUOTED_DATA_NOTICE, formatAge } from "../briefing/render.ts";
import {
  bareUntrusted as bare,
  safeId,
  sanitizeUntrusted,
} from "../briefing/sanitize.ts";
import type {
  Diagnosis,
  DiagnosisClaim,
  DiagnosisEdge,
  ExternalClaimRef,
  WorkContextEntry,
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
export const renderDiagnosis = (diagnosis: Diagnosis): string => {
  const index = authorIndex(diagnosis.claims);
  const context = diagnosis.workContext;
  const header = `crosscheck diagnosis for work context ${safeId(context.id)}. ${QUOTED_DATA_NOTICE}`;
  const contextLine = `Work context ${quoted(context.title, MAX_WORK_CONTEXT_TITLE_CHARS)} · status ${bare(context.status)} · opened by ${authorLabel(index, context.sessionId)}`;

  const opening =
    diagnosis.claims.length === 0
      ? [header, contextLine, "Claims: no claims recorded yet."]
      : [header, contextLine];

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

/** One work context the lexical search matched, with its age at query time. */
export interface SearchHit {
  readonly entry: WorkContextEntry;
  readonly ageMs: number;
}

const searchLine = (hit: SearchHit): string => {
  const author =
    hit.entry.developerName === undefined ? "" : bare(hit.entry.developerName);
  const facts = [
    `- ${safeId(hit.entry.id)}`,
    author.length === 0 ? UNNAMED_AUTHOR : author,
    `${formatAge(hit.ageMs)} ago`,
    `status ${bare(hit.entry.status)}`,
  ];
  return `${facts.join(" · ")}: ${quoted(hit.entry.title, MAX_WORK_CONTEXT_TITLE_CHARS)}`;
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

export interface SearchRenderOptions {
  /** The hub reported its vector tier ran for this search. */
  readonly semanticTier?: boolean;
}

const searchMethodLine = (options: SearchRenderOptions): string =>
  options.semanticTier === true
    ? SEARCH_METHOD_SEMANTIC
    : SEARCH_METHOD_LEXICAL;

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
    searchMethodLine(options),
  ];
  if (hits.length === 0) {
    return [...opening, "No work context on this repo matched that query."].join(
      "\n",
    );
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
