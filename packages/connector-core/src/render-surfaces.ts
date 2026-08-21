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
  renderClaimHint,
  renderPointerHint,
  renderTripwireReason,
} from "./hints/render.ts";
import {
  renderDiagnosis,
  renderSearchResults,
  renderUnusableQuery,
} from "./mcp/render.ts";
import { renderRefereeBrief } from "./mcp/render-referee.ts";
import { composeDetachedTitle } from "./flows/work-context-title.ts";
import type {
  Diagnosis,
  HintClaimCandidate,
  PresenceEntry,
  RefereeBrief,
  RefereeClaim,
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

const presenceWith = (payload: string): PresenceEntry => ({
  sessionId: "cc_11111111-2222-4333-8444-555555555555",
  developerId: "dev_other",
  developerName: payload,
  branch: payload,
  status: payload,
  lastHeartbeatAt: ISO,
  isSelf: false,
});

const workContextWith = (payload: string): WorkContextEntry => ({
  id: "wc_cc_11111111-2222-4333-8444-555555555555",
  developerId: "dev_other",
  developerName: payload,
  title: payload,
  status: "implementing",
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
  developerId: "dev_other",
  developerName: payload,
  createdAt: ISO,
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
});

const diagnosisWith = (payload: string): Diagnosis => ({
  workContext: {
    id: "wc_cc_11111111-2222-4333-8444-555555555555",
    sessionId: "cc_11111111-2222-4333-8444-555555555555",
    title: payload,
    status: "implementing",
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
              createdAt: ISO,
            },
            ageMs: 60_000,
          },
        ],
        payload,
      ),
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
    name: "mcp-tool-review-draft",
    module: "src/mcp/tools/review-draft.ts",
    note: "ids through safeId; promoted body through quoted under quotingText",
    corpusCoveredBy: ["test/mcp-hostile-hub.test.ts"],
  },
  {
    kind: "composite",
    name: "mcp-tool-search-related-work",
    module: "src/mcp/tools/search-related-work.ts",
    note: "renders through renderSearchResults/renderUnusableQuery (registered above)",
  },
];
