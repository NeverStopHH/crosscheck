/**
 * The Cursor connector's render-surface registration (§4.4 of
 * DESIGN-agent-agnostic.md). Same contract as the core, Claude and ACP
 * registries: every module in this package that touches the render layer
 * appears here, and the meta-test
 * (connector-core/test/render-surface-registry.test.ts) fails the build on
 * one that does not.
 *
 * The Block-7 surfaces — the sessionStart briefing, the
 * failure-matched hint (claim + pointer variants) and the solved-before
 * hint — are CORPUS surfaces
 * that attack the REAL emitted payload: each adapter plants the payload in
 * every untrusted slot, renders through the core renderer, ENCODES into the
 * hook's actual stdout JSON (`cursorInjectionOutput`) and DECODES back the
 * `additional_context` string a Cursor build would inject
 * (`deliveredAdditionalContext`) — so the corpus holds the notice and the
 * « » frame to the framed-class invariants across the real JSON round trip,
 * not on an intermediate string.
 */
import type { RenderSurface } from "@crosscheck/connector-core/render-surfaces.ts";
import type {
  HintClaimCandidate,
  IntentEntry,
  PresenceEntry,
  SolvedMatchEntry,
  WorkContextEntry,
} from "@crosscheck/connector-core/http/hub.ts";

import {
  cursorBriefingContext,
  cursorClaimHintContext,
  cursorPointerHintContext,
  cursorSolvedHintContext,
} from "./inject/output.ts";

const NOW = new Date("2026-08-19T12:00:00.000Z");
const ISO = "2026-08-19T11:55:00.000Z";

/** The payload in the intent slot too — every surface below renders it. */
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

export const RENDER_SURFACES: readonly RenderSurface[] = [
  {
    kind: "corpus",
    name: "cursor-briefing-context",
    module: "src/inject/output.ts",
    framing: "framed",
    render: (payload) =>
      cursorBriefingContext({
        repoId: "github.com/acme/api",
        selfDeveloperId: "dev_self",
        presence: [presenceWith(payload)],
        workContexts: [workContextWith(payload)],
        now: NOW,
      }),
  },
  {
    kind: "corpus",
    name: "cursor-claim-hint-context",
    module: "src/inject/output.ts",
    framing: "framed",
    render: (payload) =>
      cursorClaimHintContext({
        claim: hintClaimWith(payload),
        context: hintContextWith(payload),
        drift: null,
        now: NOW,
      }),
  },
  {
    kind: "corpus",
    name: "cursor-solved-hint-context",
    module: "src/inject/output.ts",
    framing: "framed",
    // The failure-time surface (VISION.md §1). It is the only Cursor
    // injection that carries a teammate-written BODY unasked — the recorded
    // root cause — so it goes through the same JSON round trip as its
    // siblings rather than being trusted because the core renderer built it.
    render: (payload) =>
      cursorSolvedHintContext(
        solvedMatchWith(payload),
        "github.com/acme/api",
        NOW,
      ),
  },
  {
    kind: "corpus",
    name: "cursor-pointer-hint-context",
    module: "src/inject/output.ts",
    framing: "framed",
    render: (payload) =>
      cursorPointerHintContext({
        context: hintContextWith(payload),
        claimCount: 2,
        drift: null,
        now: NOW,
      }),
  },
];
