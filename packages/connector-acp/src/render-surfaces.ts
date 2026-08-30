/**
 * The ACP connector's render-surface registration (§4.4 of
 * DESIGN-agent-agnostic.md). Same contract as connector-core's and
 * connector-claude's registries: every module in this package that touches
 * the render layer appears here, and the meta-test
 * (connector-core/test/render-surface-registry.test.ts) fails the build on
 * one that does not.
 *
 * The two Block-5 surfaces — the first-prompt briefing block and the
 * per-prompt hint block (claim + pointer variants) — are CORPUS surfaces:
 * each adapter plants the payload in every untrusted slot of the delivered
 * composition (core renderer through the src/inject/blocks.ts wrapper) and
 * the corpus holds them to the framed-class invariants.
 */
import type { RenderSurface } from "@crosscheck/connector-core/render-surfaces.ts";
import type {
  HintClaimCandidate,
  IntentEntry,
  PresenceEntry,
  WorkContextEntry,
} from "@crosscheck/connector-core/http/hub.ts";

import {
  acpBriefingBlock,
  acpClaimHintBlock,
  acpPointerHintBlock,
} from "./inject/blocks.ts";

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

export const RENDER_SURFACES: readonly RenderSurface[] = [
  {
    kind: "corpus",
    name: "acp-briefing-block",
    delivery: "unsolicited",
    module: "src/inject/blocks.ts",
    framing: "framed",
    render: (payload) =>
      acpBriefingBlock({
        repoId: "github.com/acme/api",
        selfDeveloperId: "dev_self",
        presence: [presenceWith(payload)],
        workContexts: [workContextWith(payload)],
        now: NOW,
      }),
  },
  {
    kind: "corpus",
    name: "acp-claim-hint-block",
    delivery: "unsolicited",
    module: "src/inject/blocks.ts",
    framing: "framed",
    render: (payload) =>
      acpClaimHintBlock({
        claim: hintClaimWith(payload),
        context: hintContextWith(payload),
        drift: null,
        now: NOW,
      }),
  },
  {
    kind: "corpus",
    name: "acp-pointer-hint-block",
    delivery: "unsolicited",
    module: "src/inject/blocks.ts",
    framing: "framed",
    render: (payload) =>
      acpPointerHintBlock({
        context: hintContextWith(payload),
        claimCount: 2,
        drift: null,
        now: NOW,
      }),
  },
];
