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
import { renderConferenceReport } from "./conference/report.ts";
import { formatSummarizerFailure } from "./model/runner.ts";
import { ghostDraftBody } from "./briefing/ghost.ts";
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
  ConferenceContext,
  ConferenceCorpus,
  ContradictionEntry,
  Diagnosis,
  GhostCheckEntry,
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

/**
 * HOW the surface's output reaches a reader — DESIGN.md §4's anchoring
 * asymmetry, as a field rather than as a habit.
 *
 *   pulled       — the reader asked for this exact thing and is waiting for
 *                  the answer: an MCP tool response, a command's stdout.
 *                  SUBSTANCE BELONGS HERE, at whatever length the author
 *                  wrote it.
 *   unsolicited  — it arrives without being asked for: a briefing at
 *                  SessionStart, a hint mid-prompt, a statusline, a report
 *                  written for later. Substance here anchors a session on
 *                  somebody else's theory and spends a budget every other
 *                  teammate shares, so these stay TIGHT.
 *   outbound     — it is not shown to this reader at all; it is text on its
 *                  way to the hub. Bounded by the schema it will be stored
 *                  under, and held to the unsolicited rule here because a
 *                  stored body is what some future briefing will show.
 *
 * WHY IT IS DATA AND WHY IT IS REQUIRED. The separation between a pulled cap
 * and an unsolicited one is enforced by test/anchoring-separation.test.ts,
 * which walks THIS FIELD across every package. A hand-kept list of "the tight
 * surfaces" would be a copy of the registry that drifts from it; a required
 * field means a surface added without a classification is a type error, and a
 * surface that later starts leaking is a red test rather than a review catch.
 */
export type RenderSurfaceDelivery = "pulled" | "unsolicited" | "outbound";

export interface CorpusRenderSurface {
  readonly kind: "corpus";
  readonly name: string;
  readonly delivery: RenderSurfaceDelivery;
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
  readonly delivery: RenderSurfaceDelivery;
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
  "src/briefing/ghost.ts",
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
 * The payload in EVERY untrusted slot of a ghost check (VISION.md §3): the
 * teammate's display name, their work-context title, their intent sentence,
 * and — the slot no other surface has — a SHARED TARGET VALUE. A file path is
 * hub-sent text that lands OUTSIDE the « » frame beside the reader's own
 * facts, so it is the newest way to try to mint a field on a briefing line.
 */
const ghostCheckWith = (payload: string): GhostCheckEntry => ({
  workContextId: "wc_cc_11111111-2222-4333-8444-555555555555",
  title: payload,
  developerId: "dev_other",
  developerName: payload,
  intent: intentWith(payload),
  lastActiveAt: ISO,
  sharedTargets: [
    { kind: "error_fingerprint", value: payload },
    { kind: "file", value: payload },
  ],
  sharedTargetCount: 4,
  intentTokenHits: 3,
});

/**
 * One conference context with the payload in each of its own untrusted slots
 * — the owner's display name, the title, the intent sentence, and a DECLARED
 * claim whose kind, status, provenance, author and BODY all carry it. The
 * body is the slot that matters most: a conference report is the one surface
 * that quotes a teammate's finding at length, because the reader asked for it.
 */
const conferenceContextWith = (
  payload: string,
  id: string,
): ConferenceContext => ({
  id,
  title: payload,
  developerId: "dev_other",
  developerName: payload,
  status: payload,
  intent: intentWith(payload),
  lastActiveAt: ISO,
  claims: [
    {
      id: "cl_0001",
      kind: payload,
      status: payload,
      confidence: 0.8,
      provenance: payload,
      body: payload,
      authorDeveloperName: payload,
      createdAt: ISO,
    },
  ],
});

const contradictionEntryWith = (payload: string): ContradictionEntry => ({
  id: "cx_0001",
  claimA: {
    id: "cl_000a",
    workContextId: "wc_cc_11111111-2222-4333-8444-555555555555",
    kind: payload,
    status: payload,
    authorDeveloperName: payload,
  },
  claimB: {
    id: "cl_000b",
    workContextId: "wc_cc_22222222-2222-4333-8444-555555555555",
    kind: payload,
    status: payload,
    authorDeveloperName: payload,
  },
  reason: payload,
  similarity: 0.94,
});

const CONFERENCE_CONTEXT_A = "wc_cc_11111111-2222-4333-8444-555555555555";
const CONFERENCE_CONTEXT_B = "wc_cc_22222222-2222-4333-8444-555555555555";

/**
 * The whole conference corpus with the payload in every slot at once: two
 * contexts, the SHARED TARGET VALUE between them (hub text printed BARE, the
 * ghost line's newest field-minting surface), a question whose asker, target
 * and context title all carry it — and no question BODY, because the hub
 * sends none — and a contradiction pointer naming both sides.
 */
const conferenceCorpusWith = (payload: string): ConferenceCorpus => ({
  contexts: [
    conferenceContextWith(payload, CONFERENCE_CONTEXT_A),
    conferenceContextWith(payload, CONFERENCE_CONTEXT_B),
  ],
  overlaps: [
    {
      workContextIdA: CONFERENCE_CONTEXT_A,
      workContextIdB: CONFERENCE_CONTEXT_B,
      sharedTargets: [
        { kind: "error_fingerprint", value: payload },
        { kind: "file", value: payload },
      ],
      sharedTargetCount: 4,
    },
  ],
  questions: [
    {
      id: "qn_11111111-2222-4333-8444-555555555555",
      authorDeveloperName: payload,
      targetDeveloperName: payload,
      workContextId: CONFERENCE_CONTEXT_A,
      workContextTitle: payload,
      createdAt: ISO,
      isForReader: true,
    },
  ],
  contradictions: [contradictionEntryWith(payload)],
  contextsInWindow: 47,
  contextsInWindowCapped: false,
  windowDays: 14,
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
  // Required at render, so the corpus would stop covering the cause line
  // without it — the body is only sanitized when it is printed.
  rootCauseConfidence: 0.9,
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
  // The TARGET slots (Nick's gap 2): kind and value are both author-written
  // and both now reach the reader, so the corpus has to plant in them.
  targets: [{ kind: payload, value: payload }],
  targetsReported: true,
  droppedTargets: 0,
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
    delivery: "unsolicited",
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
    delivery: "unsolicited",
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
    delivery: "unsolicited",
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
    name: "briefing-ghost",
    delivery: "unsolicited",
    module: "src/briefing/ghost.ts",
    framing: "framed",
    // The GHOST slot of the briefing, which neither surface above can reach:
    // they pass no ghost checks, so the section never renders there and its
    // four untrusted fields — teammate name, title, intent and the shared
    // target VALUE — were attacked by nothing.
    render: (payload) =>
      renderBriefing({
        repoId: "github.com/acme/api",
        selfDeveloperId: "dev_self",
        presence: [],
        workContexts: [],
        ghostChecks: [ghostCheckWith(payload)],
        now: NOW,
      }),
  },
  {
    kind: "corpus",
    name: "briefing-ghost-draft-body",
    delivery: "outbound",
    module: "src/briefing/ghost.ts",
    framing: "sanitized",
    // The ghost DRAFT body, which is the one ghost string that is STORED
    // rather than only printed: the gated half's sentence plus the teammate
    // it collides with, on its way into a claim the hub keeps. Only the two
    // hub-sent halves are attacked here — the name and the context id —
    // because the sentence is this machine's own model output and travels
    // like every other draft body (briefing/ghost.ts says why).
    render: (payload) =>
      ghostDraftBody(
        "Both plans change what verifyToken returns for an unknown kid",
        ghostCheckWith(payload),
      ),
  },
  {
    kind: "corpus",
    name: "conference-report",
    delivery: "unsolicited",
    module: "src/conference/report.ts",
    framing: "framed",
    // The one surface that quotes teammate BODIES at length (VISION.md §2),
    // written to a file a human — and often an agent, pasted in — reads
    // later. Every slot at once: the repo label, two contexts with their
    // names, titles, intents and claims, the shared VALUES between them, an
    // open question's people, a contradiction's two sides, and the model's
    // own sentence.
    render: (payload) =>
      renderConferenceReport({
        repoId: payload,
        corpus: conferenceCorpusWith(payload),
        findings: [
          {
            sentence: payload,
            contexts: [
              conferenceContextWith(payload, CONFERENCE_CONTEXT_A),
              conferenceContextWith(payload, CONFERENCE_CONTEXT_B),
            ],
          },
        ],
        modelOutcome: { kind: "answered" },
        now: NOW,
      }),
  },
  {
    kind: "corpus",
    name: "conference-report-model-failure",
    delivery: "unsolicited",
    module: "src/conference/report.ts",
    framing: "framed",
    // The branch the entry above cannot reach: what the nested `claude` SAID
    // when the run was lost, on its way onto the page. Model/CLI stdout is
    // untrusted text and this is the only place the report prints any.
    render: (payload) =>
      renderConferenceReport({
        repoId: "github.com/acme/api",
        corpus: conferenceCorpusWith("rate limit fix"),
        findings: [],
        modelOutcome: { kind: "failed", reason: payload },
        now: NOW,
      }),
  },
  {
    kind: "corpus",
    name: "model-failure-line",
    // Carried across the move: connector-claude classified this exact line
    // `pulled` when it was `claude-summarizer-failure-line` — it reaches a
    // reader as `crosscheck status`/`doctor` stdout.
    delivery: "pulled",
    module: "src/model/runner.ts",
    framing: "bare",
    // What the MODEL BINARY said when a run was lost (trial finding #14) —
    // CLI/model stdout, untrusted — on its way into session state
    // (summarizerLastFailure) and from there onto the status and doctor
    // lines: its first line through bareUntrusted, the whole line bounded
    // to SUMMARIZER_FAILURE_MAX_CHARS. The probe's first-line and version
    // fields come through the same function (bareSummarizerLine).
    //
    // REGISTERED HERE SINCE THE SEAM MOVED: the runner was
    // connector-claude's (its registry named it
    // `claude-summarizer-failure-line`) until every connector needed to be
    // able to spawn a model. One door, one registration, one corpus run —
    // wherever the failure line is eventually printed.
    render: (payload) =>
      formatSummarizerFailure({
        ok: false,
        reason: "exit",
        exitCode: 1,
        detail: payload,
        elapsedMs: 0,
      }),
  },
  {
    kind: "composite",
    name: "derive-ghost-draft",
    // Carried across the move: connector-claude classified this exact draft
    // `outbound` when it was `claude-ghost-draft` — it is text on its way to
    // the hub, not shown to the developer who produced it.
    delivery: "outbound",
    module: "src/derive/ghost/worker.ts",
    note: "the draft body is composed by ghostDraftBody, the registered core surface briefing-ghost-draft-body, which is where the hostile corpus attacks the teammate name and context id; the sentence beside them is this machine's own model output, bounded, echo-checked and secret-scanned here, and framed by formatDraftLine when it is shown",
  },
  {
    kind: "corpus",
    name: "open-questions-list",
    delivery: "pulled",
    module: "src/mcp/tools/list-open-questions.ts",
    framing: "framed",
    render: (payload) => renderOpenQuestions([inboxQuestionWith(payload)], NOW),
  },
  {
    kind: "corpus",
    name: "answer-hint",
    delivery: "unsolicited",
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
    delivery: "unsolicited",
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
    delivery: "unsolicited",
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
    // The #19 targets-only pointer: the touched-file `value` is teammate-
    // controlled text (a path they edited), planted here alongside the title
    // and author so bare() + the title cap are exercised on it too.
    kind: "corpus",
    name: "targets-pointer-hint",
    // UNSOLICITED, like every other pointer: it arrives on UserPromptSubmit
    // without being asked for. It carries no claim body at all — the touched
    // path rides through bare() at MAX_WORK_CONTEXT_TITLE_CHARS — so the
    // separation test's identity assertion is satisfied by construction
    // rather than by a cap chosen here.
    delivery: "unsolicited",
    module: "src/hints/render.ts",
    framing: "framed",
    render: (payload) =>
      renderPointerHint({
        context: hintContextWith(payload),
        claimCount: 0,
        matchedTarget: { value: payload, createdAt: ISO },
        drift: NO_DRIFT,
        now: NOW,
      }),
  },
  {
    kind: "corpus",
    name: "solved-hint",
    delivery: "unsolicited",
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
    delivery: "unsolicited",
    module: "src/hints/render.ts",
    framing: "framed",
    render: (payload) =>
      renderTripwireReason(tripwireSessionWith(payload), "src/app.ts", NOW),
  },
  {
    kind: "corpus",
    name: "diagnosis",
    delivery: "pulled",
    module: "src/mcp/render.ts",
    framing: "framed",
    render: (payload) => renderDiagnosis(diagnosisWith(payload), NOW),
  },
  {
    kind: "corpus",
    name: "search-results",
    delivery: "pulled",
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
    delivery: "pulled",
    module: "src/mcp/render.ts",
    framing: "framed",
    // The hub's own sentence about why a filter did not resolve — hub-chosen
    // text, therefore untrusted text, planted beside the caller's query.
    render: (payload) => renderSearchFilterRefusal(payload, payload),
  },
  {
    kind: "corpus",
    name: "search-results-empty-filtered",
    delivery: "pulled",
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
    delivery: "pulled",
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
    delivery: "pulled",
    module: "src/mcp/render.ts",
    framing: "framed",
    render: (payload) => renderUnusableQuery(payload, 3),
  },
  {
    kind: "corpus",
    name: "referee-brief",
    delivery: "pulled",
    module: "src/mcp/render-referee.ts",
    framing: "framed",
    render: (payload) => renderRefereeBrief(refereeBriefWith(payload), NOW),
  },
  {
    kind: "corpus",
    name: "detached-work-context-title",
    delivery: "outbound",
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
    delivery: "unsolicited",
    module: "src/flows/briefing.ts",
    note: "emits renderBriefing output verbatim (registered above); formatSolvedLine only re-derives lines the rendered text already contains",
    corpusCoveredBy: ["test/briefing-flow.test.ts"],
  },
  {
    kind: "composite",
    name: "hint-flow",
    delivery: "unsolicited",
    module: "src/flows/hint.ts",
    note: "emits renderClaimHint/renderPointerHint output verbatim (registered above)",
    corpusCoveredBy: ["test/hint-flow.test.ts"],
  },
  {
    kind: "composite",
    name: "solved-hint-flow",
    delivery: "unsolicited",
    module: "src/flows/solved-hint.ts",
    note: "emits renderSolvedHint output verbatim (registered above); no string of its own",
    corpusCoveredBy: ["test/solved-hint-flow.test.ts"],
  },
  {
    kind: "composite",
    name: "mcp-violations",
    delivery: "pulled",
    module: "src/mcp/violations.ts",
    note: "hub-sent issue strings through quoted()",
    corpusCoveredBy: ["test/mcp-violations.test.ts", "test/mcp-hostile-hub.test.ts"],
  },
  {
    kind: "composite",
    name: "mcp-tools-shared",
    delivery: "pulled",
    module: "src/mcp/tools/shared.ts",
    note: "hub failure codes through safeId, messages through quoted",
    corpusCoveredBy: ["test/mcp-hostile-hub.test.ts"],
  },
  {
    kind: "composite",
    name: "mcp-tools-dispatch",
    delivery: "pulled",
    module: "src/mcp/tools/index.ts",
    note: "caller's unknown tool name echoed through quoted under quotingText",
  },
  {
    kind: "composite",
    name: "mcp-tool-get-diagnosis",
    delivery: "pulled",
    module: "src/mcp/tools/get-diagnosis.ts",
    note: "renders through renderDiagnosis (registered above); not-found echo through quoted",
    corpusCoveredBy: ["test/mcp-injection.test.ts", "test/mcp-hostile-hub.test.ts"],
  },
  {
    kind: "composite",
    name: "mcp-tool-extend-diagnosis",
    delivery: "pulled",
    module: "src/mcp/tools/extend-diagnosis.ts",
    note: "ids through safeId, caller echo through quoted",
    corpusCoveredBy: ["test/mcp-injection.test.ts", "test/mcp-hostile-hub.test.ts"],
  },
  {
    kind: "composite",
    name: "mcp-tool-get-referee-brief",
    delivery: "pulled",
    module: "src/mcp/tools/get-referee-brief.ts",
    note: "renders through renderRefereeBrief (registered above); not-found echo through quoted",
  },
  {
    kind: "composite",
    name: "mcp-tool-publish-claim",
    delivery: "pulled",
    module: "src/mcp/tools/publish-claim.ts",
    note: "ids through safeId under quotingText",
    corpusCoveredBy: ["test/mcp-hostile-hub.test.ts"],
  },
  {
    kind: "composite",
    name: "mcp-tool-set-intent",
    delivery: "pulled",
    module: "src/mcp/tools/set-intent.ts",
    note: "ids through safeId; the echoed summary through quoted under quotingText; the ghost block through renderGhostNotice, whose every field is hub-sent (teammate name, title, intent, shared path)",
    corpusCoveredBy: ["test/mcp-hostile-hub.test.ts"],
  },
  {
    kind: "composite",
    name: "mcp-tool-review-draft",
    delivery: "pulled",
    module: "src/mcp/tools/review-draft.ts",
    note: "ids through safeId; promoted body through quoted under quotingText",
    corpusCoveredBy: ["test/mcp-hostile-hub.test.ts"],
  },
  {
    kind: "composite",
    name: "mcp-tool-ask-teammate",
    delivery: "pulled",
    module: "src/mcp/tools/ask-teammate.ts",
    note: "ids through safeId; the echoed question through quoted under quotingText",
    corpusCoveredBy: ["test/mcp-hostile-hub.test.ts"],
  },
  {
    kind: "composite",
    name: "mcp-tool-answer-question",
    delivery: "pulled",
    module: "src/mcp/tools/answer-question.ts",
    note: "ids through safeId; the echoed answer body through quoted under quotingText",
    corpusCoveredBy: ["test/mcp-hostile-hub.test.ts"],
  },
  {
    kind: "composite",
    name: "mcp-tool-search-related-work",
    delivery: "pulled",
    module: "src/mcp/tools/search-related-work.ts",
    note: "renders through renderSearchResults/renderUnusableQuery/renderUnappliedFilters (registered above)",
  },
];
