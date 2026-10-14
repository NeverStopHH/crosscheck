/**
 * The briefing's header ALWAYS carries QUOTED_DATA_NOTICE.
 *
 * A round of this branch dropped it from briefings whose only quoted text was
 * the reader's "own" drafts — and own drafts are not purely the reader's text:
 * a ghost draft is "<Teammate>'s live plan collides: <a sentence about the
 * teammate's plan>" (briefing/ghost.ts ghostDraftBody), and a conference draft
 * is a model's synthesis over teammates' claims. Without the notice that « »
 * text reached the agent unlabelled. Every framed surface carries the notice
 * (render-surfaces.ts, `framed`), and nothing here may pin its absence.
 *
 * The own-drafts block carries OWN_DRAFTS_QUOTED_DATA_NOTICE IN ADDITION, on
 * a briefing of the reader's own drafts alone too: at a prompt-injection
 * boundary, one notice too many rather than one too few.
 */
import { describe, expect, test } from "bun:test";

import { ghostDraftBody } from "../src/briefing/ghost.ts";
import { OWN_DRAFTS_QUOTED_DATA_NOTICE, QUOTED_DATA_NOTICE, renderBriefing } from "../src/briefing/render.ts";
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
  /** The coverage line; null for a briefing with none. */
  readonly coverageLine?: string | null;
}): readonly string[] => {
  const coverageLine = input.coverageLine === undefined ? COVERAGE : input.coverageLine;
  return renderBriefing({
    repoId: "github.com/acme/api",
    selfDeveloperId: "dev_self",
    presence: input.presence ?? [],
    workContexts: [],
    drafts: input.drafts ?? [],
    ...(coverageLine === null ? {} : { coverageLine }),
    now: NOW,
  }).split("\n");
};

describe("the quoted-data notice is on every briefing", () => {
  test("a drafts-only briefing whose draft quotes a teammate's plan carries the notice", () => {
    const lines = briefing({ drafts: [ghostDraft] });

    expect(lines[0]).toBe(HEADER);
    // …and the teammate's words are what the frame holds
    expect(lines.some((line) => line.includes("«Ken's live plan collides"))).toBe(true);
  });

  test("a briefing of the reader's own drafts alone, with no coverage line, carries it — and the drafts block its own", () => {
    const lines = briefing({ drafts: [ghostDraft], coverageLine: null });

    expect(lines[0]).toBe(HEADER);
    expect(lines.some((line) => line.endsWith(OWN_DRAFTS_QUOTED_DATA_NOTICE))).toBe(true);
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
