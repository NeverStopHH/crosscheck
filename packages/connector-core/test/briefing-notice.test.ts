/**
 * NO « » TEXT REACHES THE AGENT UNLABELLED: the briefing's header carries
 * QUOTED_DATA_NOTICE whenever the briefing holds anything besides the
 * reader's own drafts — a coverage line included.
 *
 * A round of this branch dropped it from briefings whose only quoted text was
 * the reader's "own" drafts — and own drafts are not purely the reader's text:
 * a ghost draft is "<Teammate>'s live plan collides: <a sentence about the
 * teammate's plan>" (briefing/ghost.ts ghostDraftBody), and a conference draft
 * is a model's synthesis over teammates' claims. Without a notice that « »
 * text reached the agent unlabelled.
 *
 * MERGED WITH THE DRAFTS BRANCH: a briefing of own drafts ALONE heads that
 * block with OWN_DRAFTS_QUOTED_DATA_NOTICE, which says the drafts may quote
 * teammates and are quoted data, and leaves this notice off — test/draft-
 * nudge.test.ts pins that half, ghost and conference drafts included. Every
 * framed surface carries ITS notice (render-surfaces.ts, `framed`, `notice`).
 */
import { describe, expect, test } from "bun:test";

import { ghostDraftBody } from "../src/briefing/ghost.ts";
import { QUOTED_DATA_NOTICE, renderBriefing } from "../src/briefing/render.ts";
import type { DraftEntry, PresenceEntry } from "../src/http/hub.ts";

const NOW = new Date("2026-08-21T12:00:00.000Z");
const HEADER = `crosscheck facts about github.com/acme/api. ${QUOTED_DATA_NOTICE}`;
const COVERAGE = "Coverage incomplete: agent sessions reported since 2026-08-20T12:00Z.";

/** A ghost draft exactly as the ghost worker stores one: a teammate's plan. */
const ghostDraft: DraftEntry = {
  id: "clm_ghost",
  workContextId: "wc_own",
  kind: "hypothesis",
  body: ghostDraftBody("Both plans rewrite the token refresh path in src/auth/refresh.ts", {
    workContextId: "wc_ken",
    title: "feat/auth @ api",
    developerId: "dev_ken",
    developerName: "Ken",
    intent: null,
    lastActiveAt: NOW.toISOString(),
    sharedTargets: [],
    sharedTargetCount: 0,
    intentTokenHits: 0,
  }),
  status: "proposed",
  confidence: 0.3,
  createdAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
};

const teammate: PresenceEntry = {
  sessionId: "cc_ken",
  developerId: "dev_ken",
  developerName: "Ken",
  branch: "feat/auth",
  status: "implementing",
  lastHeartbeatAt: new Date(NOW.getTime() - 30_000).toISOString(),
  isSelf: false,
};

const briefing = (input: {
  readonly presence?: readonly PresenceEntry[];
  readonly drafts?: readonly DraftEntry[];
}): readonly string[] =>
  renderBriefing({
    repoId: "github.com/acme/api",
    selfDeveloperId: "dev_self",
    presence: input.presence ?? [],
    workContexts: [],
    drafts: input.drafts ?? [],
    coverageLine: COVERAGE,
    now: NOW,
  }).split("\n");

describe("the quoted-data notice is on every briefing", () => {
  test("a drafts-only briefing whose draft quotes a teammate's plan carries the notice", () => {
    const lines = briefing({ drafts: [ghostDraft] });

    expect(lines[0]).toBe(HEADER);
    // …and the teammate's words are what the frame holds
    expect(lines.some((line) => line.includes("«Ken's live plan collides"))).toBe(true);
  });

  test("a coverage line alone carries it too", () => {
    expect(briefing({})[0]).toBe(HEADER);
  });

  test("a teammate's section carries it, drafts or not", () => {
    expect(briefing({ presence: [teammate], drafts: [ghostDraft] })[0]).toBe(HEADER);
    expect(briefing({ presence: [teammate] })[0]).toBe(HEADER);
  });
});
