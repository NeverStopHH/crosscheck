/**
 * COV-9's boundary and its escape hatch (03 §7) — AT-9, as data.
 *
 * "Fails if a person has to run doctor to learn that an answer was based on
 * partial observation." The rule is mechanised by a registry walk
 * (test/coverage-registry-walk.test.ts): every registered surface whose
 * module renders one of the six coverage-bearing responses either names a
 * CoverageRecord or appears in the list below with a reason.
 *
 * WHY THE SET IS THE SIX RESPONSES AND NOT "EVERY SURFACE". A walk over all
 * of the registered surfaces would flag the conference report, the pin
 * listing, the statusline and the seven cursor/ACP blocks that re-wrap text
 * core already rendered — eleven honest candidates against a cap of three, so
 * the list would be spent on day one and the temptation to raise the cap
 * would arrive in the same commit. §3.5 names exactly six responses that
 * carry coverage; a surface that renders one of them is a surface asserting
 * what the team knows on the strength of an archive. Everything else is out
 * of scope BY THE SPEC rather than by an exemption, which is the difference
 * between a boundary and a hole.
 *
 * VERIFY: bun -e 'const c=await import("./packages/connector-core/src/coverage/exempt-surfaces.ts");console.log(c.COVERAGE_BEARING_RESPONSES.length, c.COVERAGE_EXEMPT_SURFACES.length, c.COVERAGE_EXEMPT_SURFACES_MAX)'
 * PRINTS: 12 3 3
 */

/**
 * The response types §3.5 puts coverage on, as the names a module has to
 * mention to be rendering one. Six responses, more than six names: a response
 * is reached through its envelope type OR through the row type the renderer
 * actually takes, and a walk that only knew the envelope would miss every
 * renderer one level down.
 *
 *   GET /api/absences            → AbsencesOutcome, AbsenceEntry
 *   GET /api/search              → SearchOutcome, SearchResultEntry, SearchHit
 *   GET /api/work-contexts/:id/diagnosis → Diagnosis
 *   GET /api/hints/candidates    → HintCandidatesResult, HintContextCandidate,
 *                                  HintClaimCandidate
 *   GET /api/hints/tripwire      → TripwireOutcome, TripwireSession
 *   GET /api/suspect             → SuspectView
 */
export const COVERAGE_BEARING_RESPONSES: readonly string[] = [
  "AbsencesOutcome",
  "AbsenceEntry",
  "SearchOutcome",
  "SearchResultEntry",
  "SearchHit",
  "Diagnosis",
  "HintCandidatesResult",
  "HintContextCandidate",
  "HintClaimCandidate",
  "TripwireOutcome",
  "TripwireSession",
  "SuspectView",
];

export interface CoverageExemptSurface {
  /** A name in some package's RENDER_SURFACES — checked, never assumed. */
  readonly name: string;
  /** One line, printed in doctor, so somebody can argue with it. */
  readonly reason: string;
}

/**
 * THREE, AND NEVER RAISED TO MAKE A CASE PASS. The escape hatch may not be
 * wider than the rule it escapes: the first draft of COV-9 let the same
 * author add a surface and its exemption in one edit and keep the build
 * green, which is weaker than the precedent this spec cites — `corpusCoveredBy`
 * is machine-checked and the phrase "corpus-covered" is banned from a note
 * precisely because a prose claim of coverage is not a claim.
 *
 * So the length is a directive (above), the members are printed by `crosscheck
 * doctor`, and the cap is pinned by its own test. A fourth exemption should
 * cost an argument.
 */
export const COVERAGE_EXEMPT_SURFACES_MAX = 3;

/**
 * TWO SHAPES EARN AN EXEMPTION, and the second one arrived when specs 03 and
 * 06 met on the integration branch — neither could see it alone.
 *
 * The first: a tool wrapper that hands the WHOLE response object to a
 * registered renderer which consumes the record. The wrapper never reads
 * coverage because it never reads any field — it passes the tree on — and
 * making it name the field to satisfy a regex would be the prose claim this
 * rule exists to refuse.
 *
 * The second: a BLOCK that travels inside a surface which already consumes
 * the record. `mcp-intent-chain` is spread into `renderDiagnosis`'s own
 * output, under `renderDiagnosis`'s coverage clause, and its registration in
 * `render-surfaces.ts` says so in its own words. A block cannot carry a
 * second, narrower coverage sentence without contradicting the one above it.
 *
 * THIS IS THE THIRD OF THREE, so the escape hatch is now full. A fourth costs
 * an argument, which is what the cap is for.
 */
export const COVERAGE_EXEMPT_SURFACES: readonly CoverageExemptSurface[] = [
  {
    name: "mcp-tool-get-diagnosis",
    reason:
      "hands the whole Diagnosis to renderDiagnosis, which consumes the record and qualifies both of that surface's empty branches",
  },
  {
    name: "mcp-tool-extend-diagnosis",
    reason:
      "reads a Diagnosis only to confirm the tree exists before writing to it; the answer it renders is the write's own receipt, not a statement about what the team knows",
  },
  {
    name: "mcp-intent-chain",
    reason:
      "a block spread into renderDiagnosis, under that surface's own coverage clause; it also refuses on its own terms — it prints `never amended` only when the hub said so, and `this hub does not report it` otherwise",
  },
];
