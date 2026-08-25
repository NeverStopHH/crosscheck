/**
 * Surface registration (DESIGN-agent-agnostic.md §4.4): every module that
 * renders untrusted text is REGISTERED HERE AS DATA, and the registration is
 * enforced two ways in test/render-surface-registry.test.ts:
 *
 *   1. every registered `corpus` surface is rendered against the whole
 *      injection corpus, under the class-appropriate invariants;
 *   2. a meta-test walks every src module of every connector package for
 *      calls into the render layer and fails the build on any module that is
 *      neither the render layer itself, a barrel, nor registered below —
 *      which is what "non-negotiable" (§1.4) means mechanically. A new
 *      render file that skips registration is a RED BUILD.
 *
 * Connector packages export their own RENDER_SURFACES beside this one
 * (connector-claude/src/render-surfaces.ts); the meta-test takes the union.
 *
 * Module paths are package-relative (`src/…`), because the meta-test walks
 * package trees, not the workspace root.
 */
import type { CommitDrift } from "./git/commit-drift.ts";
import { renderBriefing } from "./briefing/render.ts";
import {
  renderAnswerHint,
  renderClaimHint,
  renderPointerHint,
  renderSolvedHint,
  renderTripwireReason,
} from "./hints/render.ts";
import { renderOpenQuestions } from "./mcp/tools/list-open-questions.ts";
import {
  renderDiagnosis,
  renderSearchFilterRefusal,
  renderSearchResults,
  renderUnappliedFilters,
  renderUnusableQuery,
} from "./mcp/render.ts";
import { renderRefereeBrief } from "./mcp/render-referee.ts";
import { composeDetachedTitle } from "./flows/work-context-title.ts";
import type {
  AnsweredQuestion,
  Diagnosis,
  HintClaimCandidate,
  InboxQuestion,
  IntentEntry,
  PresenceEntry,
  RefereeBrief,
  RefereeClaim,
  SolvedMatchEntry,
  TripwireSession,
  WorkContextEntry,
} from "./http/hub.ts";

/**
 * How a surface's output is classed, which decides its corpus assertions:
 *   framed    — a full document: carries QUOTED_DATA_NOTICE, every line under
 *               the character invariants, at most one « » pair per line;
 *   sanitized — PROSE cleaned for a frame applied LATER (a title on its way
 *               to the hub): character invariants, and no « » at all;
 *   bare      — BARE-class short field, no frame characters;
 *   id        — safeId-class output only.
 */
export type RenderSurfaceFraming = "framed" | "sanitized" | "bare" | "id";

export interface CorpusRenderSurface {
  readonly kind: "corpus";
  readonly name: string;
  /** Package-relative module the surface lives in, e.g. "src/mcp/render.ts". */
  readonly module: string;
  readonly framing: RenderSurfaceFraming;
  /** Renders with the payload planted in the surface's most exposed slot. */
  readonly render: (untrusted: string) => string;
}

/**
 * A module that renders untrusted text ONLY through registered corpus
 * surfaces or the render-layer primitives — its own strings are
 * renderer-owned literals. §4.4 calls this "renderer-owned literal, listed
 * as such": it is registered so the meta-test can see it.
 *
 * `corpusCoveredBy` is the VERIFIED half of the registration: the test files
 * where this module's own composition is exercised against the injection
 * corpus or the shared invariants. The registry test checks each named file
 * exists and really runs them — a claim of coverage is machine-checked, never
 * prose (the phrase "corpus-covered" is banned from notes for that reason).
 */
export interface CompositeRenderSurface {
  readonly kind: "composite";
  readonly name: string;
  readonly module: string;
  readonly note: string;
  /** Package-relative test files that attack this module's composition. */
  readonly corpusCoveredBy?: readonly string[];
}

export type RenderSurface = CorpusRenderSurface | CompositeRenderSurface;

/**
 * The render layer itself — the modules that DEFINE the classes and the
 * finished renderers. Exempt from surface registration because they are what
 * surfaces are made of; guarded instead by their own corpus tests.
 */
export const RENDER_LAYER_MODULES: readonly string[] = [
  "src/briefing/sanitize.ts",
  "src/briefing/intent.ts",
  "src/briefing/questions.ts",
  "src/briefing/render.ts",
  "src/hints/render.ts",
  "src/mcp/render.ts",
  "src/mcp/render-referee.ts",
];

/** Re-export barrels: they name render identifiers but render nothing. */
export const RENDER_BARREL_MODULES: readonly string[] = [
  "src/index.ts",
  "src/kit.ts",
  "src/render-surfaces.ts",
];

const NOW = new Date("2026-08-18T12:00:00.000Z");
const ISO = "2026-08-18T11:55:00.000Z";
const NO_DRIFT: CommitDrift | null = null;

/**
 * The payload in the INTENT slot too (trial finding #16): a derived intent is
 * model text, a declared one a teammate's — both land on every surface below
 * through briefing/intent.ts, so every adapter plants it.
 */
const intentWith = (payload: string): IntentEntry => ({
  summary: payload,
  provenance: "derived",
  confidence: 0.4,
  capturedAt: ISO,
});

const presenceWith = (payload: string): PresenceEntry => ({
  sessionId: "cc_11111111-2222-4333-8444-555555555555",
  developerId: "dev_other",
  developerName: payload,
  branch: payload,
  status: payload,
  lastHeartbeatAt: ISO,
  isSelf: false,
  intent: intentWith(payload),
});

const workContextWith = (payload: string): WorkContextEntry => ({
  id: "wc_cc_11111111-2222-4333-8444-555555555555",
  developerId: "dev_other",
  developerName: payload,
  title: payload,
  status: "implementing",
  intent: intentWith(payload),
  createdAt: ISO,
});

const hintClaimWith = (payload: string): HintClaimCandidate => ({
  id: "cl_0001",
  workContextId: "wc_cc_11111111-2222-4333-8444-555555555555",
  kind: "finding",
  status: "open",
  confidence: 0.8,
  provenance: "declared",
  evidenceRefCount: 1,
  authorDeveloperId: "dev_other",
  authorDeveloperName: payload,
  body: payload,
  createdAt: ISO,
});

const hintContextWith = (payload: string) => ({
  id: "wc_cc_11111111-2222-4333-8444-555555555555",
  title: payload,
  status: "implementing",
  intent: intentWith(payload),
  developerId: "dev_other",
  developerName: payload,
  createdAt: ISO,
});

/**
 * The payload in EVERY untrusted slot of a question (roadmap R2): the asker's
 * display name, the question body, and the title of the work context it is
 * about. The ids stay well-formed on purpose — an id the allowlist rejects
 * drops the whole entry, and a surface that renders nothing cannot be
 * attacked.
 */
const inboxQuestionWith = (payload: string): InboxQuestion => ({
  id: "qn_11111111-2222-4333-8444-555555555555",
  authorDeveloperId: "dev_other",
  authorDeveloperName: payload,
  body: payload,
  workContextId: "wc_cc_11111111-2222-4333-8444-555555555555",
  workContextTitle: payload,
  createdAt: ISO,
  expiresAt: "2026-09-01T11:55:00.000Z",
});

/**
 * An ANSWER carries TWO teammate-written bodies at once — the claim and the
 * question it answers — plus the answerer's name, so the payload goes into
 * all three.
 */
const answeredQuestionWith = (payload: string): AnsweredQuestion => ({
  questionId: "qn_11111111-2222-4333-8444-555555555555",
  questionBody: payload,
  claimId: "clm_11111111-2222-4333-8444-555555555555",
  claimBody: payload,
  claimKind: payload,
  claimStatus: payload,
  confidence: 0.6,
  provenance: payload,
  answererDeveloperName: payload,
  answeredAt: ISO,
});

/**
 * The payload in every untrusted slot of a solved match (VISION.md §1): the
 * solver's display name, the tree's title, the REPO the tree lives in (hub
 * text printed BARE on a ·-separated line — the newest place a field could
 * be minted), and the recorded ROOT CAUSE, which is the one teammate-written
 * BODY this section asserts rather than points at. The repo deliberately
 * differs from the briefing's own so the fragment actually renders, and the
 * kind is the fingerprint because that is the only kind the cause renders
 * under; equal repo or a weaker kind and the surface would render less than
 * it exists to attack.
 */
const solvedMatchWith = (payload: string): SolvedMatchEntry => ({
  workContextId: "wc_cc_11111111-2222-4333-8444-555555555555",
  title: payload,
  developerName: payload,
  repo: payload,
  solvedAt: ISO,
  landedAt: null,
  matchedTargetKind: "error_fingerprint",
  rootCause: payload,
});

const tripwireSessionWith = (payload: string): TripwireSession => ({
  sessionId: "cc_11111111-2222-4333-8444-555555555555",
  developerId: "dev_other",
  developerName: payload,
  branch: payload,
  status: payload,
  lastHeartbeatAt: ISO,
  workContextId: "wc_cc_11111111-2222-4333-8444-555555555555",
  workContextTitle: payload,
  workContextIntent: intentWith(payload),
});

const diagnosisWith = (payload: string): Diagnosis => ({
  workContext: {
    id: "wc_cc_11111111-2222-4333-8444-555555555555",
    sessionId: "cc_11111111-2222-4333-8444-555555555555",
    title: payload,
    status: "implementing",
    intent: intentWith(payload),
    createdAt: ISO,
  },
  claims: [
    {
      id: "cl_0001",
      workContextId: "wc_cc_11111111-2222-4333-8444-555555555555",
      authorSessionId: "cc_11111111-2222-4333-8444-555555555555",
      authorDeveloperName: payload,
      kind: "finding",
      body: payload,
      status: "open",
      confidence: 0.8,
      captureMode: "manual",
      provenance: "declared",
      dedupCount: 1,
      evidenceRefs: [],
      createdAt: ISO,
    },
  ],
  edges: [],
  externalClaims: [],
  targets: [],
  truncated: false,
  droppedRows: 0,
});

const refereeClaimWith = (payload: string, id: string): RefereeClaim => ({
  id,
  workContextId: "wc_cc_11111111-2222-4333-8444-555555555555",
  kind: "root_cause",
  status: "likely_root_cause",
  confidence: 0.8,
  body: payload,
  provenance: "declared",
  authorDeveloperName: payload,
  createdAt: ISO,
});

const refereeBriefWith = (payload: string): RefereeBrief => ({
  id: "cx_0001",
  reason: "status_conflict",
  similarity: null,
  positionA: {
    claim: refereeClaimWith(payload, "cl_000a"),
    workContextTitle: payload,
    evidence: [],
    evidenceTruncated: false,
    ruledOut: [],
    ruledOutTruncated: false,
    supersededByClaimId: null,
    droppedRows: 0,
  },
  positionB: {
    claim: refereeClaimWith(payload, "cl_000b"),
    workContextTitle: payload,
    evidence: [],
    evidenceTruncated: false,
    ruledOut: [],
    ruledOutTruncated: false,
    supersededByClaimId: null,
    droppedRows: 0,
  },
  sharedTargets: [],
  sharedTargetsTruncated: false,
  droppedRows: 0,
});

/**
 * Core's agent-facing surfaces. Every corpus adapter plants the payload in
 * EVERY untrusted slot of its surface at once — author names, branches,
 * statuses, titles, bodies — so each class the surface uses is exercised.
 */
export const RENDER_SURFACES: readonly RenderSurface[] = [
  {
    kind: "corpus",
    name: "briefing",
    module: "src/briefing/render.ts",
    framing: "framed",
    render: (payload) =>
      renderBriefing({
        repoId: "github.com/acme/api",
        selfDeveloperId: "dev_self",
        presence: [presenceWith(payload)],
        workContexts: [workContextWith(payload)],
        now: NOW,
      }),
  },
  {
    kind: "corpus",
    name: "briefing-questions",
    module: "src/briefing/questions.ts",
    framing: "framed",
    // The QUESTION slot of the briefing, which the "briefing" surface above
    // cannot reach: it passes no questions, so the block never renders there.
    // A question body is the one teammate-authored BODY this product injects
    // proactively (DESIGN.md §4), which makes it the slot most worth attacking.
    render: (payload) =>
      renderBriefing({
        repoId: "github.com/acme/api",
        selfDeveloperId: "dev_self",
        presence: [],
        workContexts: [],
        questions: [inboxQuestionWith(payload)],
        now: NOW,
      }),
  },
  {
    kind: "corpus",
    name: "briefing-solved",
    module: "src/briefing/render.ts",
    framing: "framed",
    // The SOLVED slot of the briefing, which the "briefing" surface above
    // cannot reach: it passes no matches, so the section never renders there
    // and its three untrusted fields — solver name, tree title, and the repo
    // the tree lives in — were attacked by nothing.
    render: (payload) =>
      renderBriefing({
        repoId: "github.com/acme/api",
        selfDeveloperId: "dev_self",
        presence: [],
        workContexts: [],
        solvedMatches: [solvedMatchWith(payload)],
        now: NOW,
      }),
  },
  {
    kind: "corpus",
    name: "open-questions-list",
    module: "src/mcp/tools/list-open-questions.ts",
    framing: "framed",
    render: (payload) => renderOpenQuestions([inboxQuestionWith(payload)], NOW),
  },
  {
    kind: "corpus",
    name: "answer-hint",
    module: "src/hints/render.ts",
    framing: "framed",
    // The §4 solicited-substance surface: a claim body pushed at the reader
    // BECAUSE they asked for it. Solicited does not mean trusted — it is
    // still a teammate's text landing in a healthy session.
    render: (payload) => renderAnswerHint(answeredQuestionWith(payload), NOW),
  },
  {
    kind: "corpus",
    name: "claim-hint",
    module: "src/hints/render.ts",
    framing: "framed",
    render: (payload) =>
      renderClaimHint({
        claim: hintClaimWith(payload),
        context: hintContextWith(payload),
        drift: NO_DRIFT,
        now: NOW,
      }),
  },
  {
    kind: "corpus",
    name: "pointer-hint",
    module: "src/hints/render.ts",
    framing: "framed",
    render: (payload) =>
      renderPointerHint({
        context: hintContextWith(payload),
        claimCount: 2,
        drift: NO_DRIFT,
        now: NOW,
      }),
  },
  {
    kind: "corpus",
    name: "solved-hint",
    module: "src/hints/render.ts",
    framing: "framed",
    // The failure-time surface (VISION.md §1): the same untrusted slots as
    // the briefing's solved entry — solver name, tree title, repo, recorded
    // cause — but arriving mid-turn under a header of their own.
    render: (payload) =>
      renderSolvedHint(solvedMatchWith(payload), "github.com/acme/api", NOW),
  },
  {
    kind: "corpus",
    name: "tripwire-reason",
    module: "src/hints/render.ts",
    framing: "framed",
    render: (payload) =>
      renderTripwireReason(tripwireSessionWith(payload), "src/app.ts", NOW),
  },
  {
    kind: "corpus",
    name: "diagnosis",
    module: "src/mcp/render.ts",
    framing: "framed",
    render: (payload) => renderDiagnosis(diagnosisWith(payload)),
  },
  {
    kind: "corpus",
    name: "search-results",
    module: "src/mcp/render.ts",
    framing: "framed",
    render: (payload) =>
      renderSearchResults(
        [
          {
            entry: {
              id: "wc_cc_11111111-2222-4333-8444-555555555555",
              developerId: "dev_other",
              developerName: payload,
              title: payload,
              status: payload,
              intent: intentWith(payload),
              createdAt: ISO,
            },
            ageMs: 60_000,
          },
        ],
        payload,
        // The FILTER slot too (roadmap R1): the developer name on the filter
        // line is the hub's word for a person, planted like every other
        // author-written field so the BARE class is exercised there as well.
        {
          filters: {
            developerName: payload,
            developerEmail: payload,
            sinceAgeMs: 14 * 24 * 3_600_000,
          },
        },
      ),
  },
  {
    kind: "corpus",
    name: "search-filter-refusal",
    module: "src/mcp/render.ts",
    framing: "framed",
    // The hub's own sentence about why a filter did not resolve — hub-chosen
    // text, therefore untrusted text, planted beside the caller's query.
    render: (payload) => renderSearchFilterRefusal(payload, payload),
  },
  {
    kind: "corpus",
    name: "search-results-empty-filtered",
    module: "src/mcp/render.ts",
    framing: "framed",
    // The EMPTY branch of the same renderer, which the entry above cannot
    // reach: it always passes one hit, so `noMatchLine` — the one place a
    // teammate's display name is printed bare INSIDE a sentence rather than
    // after a field label — was never attacked by the corpus. It goes through
    // `bare()` today; this is what keeps that true when somebody later edits
    // the sentence around it.
    //
    // `isSelf` false ON PURPOSE: the self branch substitutes the renderer's
    // own word "you" for the name, so it would render one fewer copy of the
    // payload than this surface exists to attack.
    render: (payload) =>
      renderSearchResults([], payload, {
        filters: {
          developerName: payload,
          developerEmail: payload,
          isSelf: false,
          sinceAgeMs: 14 * 24 * 3_600_000,
        },
      }),
  },
  {
    kind: "corpus",
    name: "search-unapplied-filters",
    module: "src/mcp/render.ts",
    framing: "framed",
    // A hub too old to apply the filters: the caller's own query is the only
    // untrusted text on the surface, and the filter names beside it are this
    // renderer's own literals.
    render: (payload) => renderUnappliedFilters(payload, ["developer", "since"]),
  },
  {
    kind: "corpus",
    name: "unusable-query",
    module: "src/mcp/render.ts",
    framing: "framed",
    render: (payload) => renderUnusableQuery(payload, 3),
  },
  {
    kind: "corpus",
    name: "referee-brief",
    module: "src/mcp/render-referee.ts",
    framing: "framed",
    render: (payload) => renderRefereeBrief(refereeBriefWith(payload), NOW),
  },
  {
    kind: "corpus",
    name: "detached-work-context-title",
    module: "src/flows/work-context-title.ts",
    framing: "sanitized",
    // A detached worktree's HEAD commit SUBJECT on its way into an uploaded
    // work-context title (trial finding #15): the commit message is the
    // developer's own text, sanitized here BEFORE it leaves the machine and
    // framed later on every teammate surface.
    render: (payload) =>
      composeDetachedTitle("detached@0badc0ffe", payload, "github.com/acme/api"),
  },
  {
    kind: "composite",
    name: "briefing-flow",
    module: "src/flows/briefing.ts",
    note: "emits renderBriefing output verbatim (registered above); formatSolvedLine only re-derives lines the rendered text already contains",
    corpusCoveredBy: ["test/briefing-flow.test.ts"],
  },
  {
    kind: "composite",
    name: "hint-flow",
    module: "src/flows/hint.ts",
    note: "emits renderClaimHint/renderPointerHint output verbatim (registered above)",
    corpusCoveredBy: ["test/hint-flow.test.ts"],
  },
  {
    kind: "composite",
    name: "solved-hint-flow",
    module: "src/flows/solved-hint.ts",
    note: "emits renderSolvedHint output verbatim (registered above); no string of its own",
    corpusCoveredBy: ["test/solved-hint-flow.test.ts"],
  },
  {
    kind: "composite",
    name: "mcp-violations",
    module: "src/mcp/violations.ts",
    note: "hub-sent issue strings through quoted()",
    corpusCoveredBy: ["test/mcp-violations.test.ts", "test/mcp-hostile-hub.test.ts"],
  },
  {
    kind: "composite",
    name: "mcp-tools-shared",
    module: "src/mcp/tools/shared.ts",
    note: "hub failure codes through safeId, messages through quoted",
    corpusCoveredBy: ["test/mcp-hostile-hub.test.ts"],
  },
  {
    kind: "composite",
    name: "mcp-tools-dispatch",
    module: "src/mcp/tools/index.ts",
    note: "caller's unknown tool name echoed through quoted under quotingText",
  },
  {
    kind: "composite",
    name: "mcp-tool-get-diagnosis",
    module: "src/mcp/tools/get-diagnosis.ts",
    note: "renders through renderDiagnosis (registered above); not-found echo through quoted",
    corpusCoveredBy: ["test/mcp-injection.test.ts", "test/mcp-hostile-hub.test.ts"],
  },
  {
    kind: "composite",
    name: "mcp-tool-extend-diagnosis",
    module: "src/mcp/tools/extend-diagnosis.ts",
    note: "ids through safeId, caller echo through quoted",
    corpusCoveredBy: ["test/mcp-injection.test.ts", "test/mcp-hostile-hub.test.ts"],
  },
  {
    kind: "composite",
    name: "mcp-tool-get-referee-brief",
    module: "src/mcp/tools/get-referee-brief.ts",
    note: "renders through renderRefereeBrief (registered above); not-found echo through quoted",
  },
  {
    kind: "composite",
    name: "mcp-tool-publish-claim",
    module: "src/mcp/tools/publish-claim.ts",
    note: "ids through safeId under quotingText",
    corpusCoveredBy: ["test/mcp-hostile-hub.test.ts"],
  },
  {
    kind: "composite",
    name: "mcp-tool-set-intent",
    module: "src/mcp/tools/set-intent.ts",
    note: "ids through safeId; the echoed summary through quoted under quotingText",
    corpusCoveredBy: ["test/mcp-hostile-hub.test.ts"],
  },
  {
    kind: "composite",
    name: "mcp-tool-review-draft",
    module: "src/mcp/tools/review-draft.ts",
    note: "ids through safeId; promoted body through quoted under quotingText",
    corpusCoveredBy: ["test/mcp-hostile-hub.test.ts"],
  },
  {
    kind: "composite",
    name: "mcp-tool-ask-teammate",
    module: "src/mcp/tools/ask-teammate.ts",
    note: "ids through safeId; the echoed question through quoted under quotingText",
    corpusCoveredBy: ["test/mcp-hostile-hub.test.ts"],
  },
  {
    kind: "composite",
    name: "mcp-tool-answer-question",
    module: "src/mcp/tools/answer-question.ts",
    note: "ids through safeId; the echoed answer body through quoted under quotingText",
    corpusCoveredBy: ["test/mcp-hostile-hub.test.ts"],
  },
  {
    kind: "composite",
    name: "mcp-tool-search-related-work",
    module: "src/mcp/tools/search-related-work.ts",
    note: "renders through renderSearchResults/renderUnusableQuery/renderUnappliedFilters (registered above)",
  },
];
