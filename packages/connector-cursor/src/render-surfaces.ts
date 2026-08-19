/**
 * The Cursor connector's render-surface registration (§4.4 of
 * DESIGN-agent-agnostic.md). Same contract as the core, Claude and ACP
 * registries: every module in this package that touches the render layer
 * appears here, and the meta-test
 * (connector-core/test/render-surface-registry.test.ts) fails the build on
 * one that does not.
 *
 * The three Block-7 surfaces — the sessionStart briefing and the
 * failure-matched hint (claim + pointer variants) — are CORPUS surfaces
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
  PresenceEntry,
  WorkContextEntry,
} from "@crosscheck/connector-core/http/hub.ts";

import {
  cursorBriefingContext,
  cursorClaimHintContext,
  cursorPointerHintContext,
} from "./inject/output.ts";

const NOW = new Date("2026-08-19T12:00:00.000Z");
const ISO = "2026-08-19T11:55:00.000Z";

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
