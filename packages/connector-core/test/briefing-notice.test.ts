/**
 * The briefing's header says "Text in « » was written by other developers"
 * only when other developers' text is in it.
 *
 * The notice rode every briefing unconditionally. A briefing whose only
 * quoted text is the reader's OWN unreviewed drafts — with a coverage line,
 * which is renderer-owned — therefore told the agent its own drafts were
 * written by somebody else.
 */
import { describe, expect, test } from "bun:test";

import { QUOTED_DATA_NOTICE, renderBriefing } from "../src/briefing/render.ts";
import type { DraftEntry, PresenceEntry } from "../src/http/hub.ts";

const NOW = new Date("2026-08-21T12:00:00.000Z");
const HEADER = "crosscheck facts about github.com/acme/api.";
const COVERAGE = "Coverage incomplete: agent sessions reported since 2026-08-20T12:00Z.";

const draft: DraftEntry = {
  id: "clm_d1",
  workContextId: "wc_own",
  kind: "root_cause",
  body: "The refresh path reuses the expired key id",
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

describe("the teammate notice is said only where teammate text is", () => {
  test("the reader's own drafts beside a coverage line are not called somebody else's", () => {
    const lines = briefing({ drafts: [draft] });

    expect(lines[0]).toBe(HEADER);
    expect(lines.join("\n")).not.toContain(QUOTED_DATA_NOTICE);
    // …and the drafts are still there: the notice went, not the section
    expect(lines.some((line) => line.includes("«The refresh path reuses the expired key id»"))).toBe(true);
  });

  test("a coverage line alone carries no teammate notice", () => {
    expect(briefing({})[0]).toBe(HEADER);
  });

  test("a teammate's section keeps the notice, drafts or not", () => {
    expect(briefing({ presence: [teammate], drafts: [draft] })[0]).toBe(
      `${HEADER} ${QUOTED_DATA_NOTICE}`,
    );
    expect(briefing({ presence: [teammate] })[0]).toBe(`${HEADER} ${QUOTED_DATA_NOTICE}`);
  });
});
