/**
 * "Teammate sessions active now" runs the same topic grouping as the work
 * contexts below it (briefing/topic-group.ts): a teammate's live sessions are
 * grouped by branch, the branch list is bounded with the rest counted, and
 * the status shown is the highest-ranked one on the freshest branch.
 */
import { describe, expect, test } from "bun:test";

import { MAX_TOPICS_PER_TEAMMATE } from "../src/constants.ts";
import { groupTeammates, renderBriefing } from "../src/briefing/render.ts";
import type { PresenceEntry } from "../src/http/hub.ts";

const NOW = new Date("2026-08-21T12:00:00.000Z");
const secondsAgo = (seconds: number): string =>
  new Date(NOW.getTime() - seconds * 1000).toISOString();

const live = (
  index: number,
  branch: string,
  overrides: Partial<PresenceEntry> = {},
): PresenceEntry => ({
  sessionId: `cc_nick_${String(index)}`,
  developerId: "dev_nick",
  developerName: "Nick",
  branch,
  status: "analyzing",
  lastHeartbeatAt: secondsAgo(10 + index),
  isSelf: false,
  ...overrides,
});

const presenceLines = (presence: readonly PresenceEntry[]): readonly string[] => {
  const rendered = renderBriefing({
    repoId: "github.com/acme/api",
    selfDeveloperId: "dev_self",
    presence,
    workContexts: [],
    now: NOW,
  });
  return rendered.split("\n").filter((line) => line.startsWith("- "));
};

describe("a teammate's live sessions, grouped by topic", () => {
  test("live branches beyond the cap are counted, never silently cut", () => {
    // Arrange: Nick has sessions live on two more branches than a line shows
    const branches = Array.from(
      { length: MAX_TOPICS_PER_TEAMMATE + 2 },
      (_unused, index) => `feat/b${String(index)}`,
    );
    const lines = presenceLines(branches.map((branch, index) => live(index, branch)));

    // Assert: freshest first, the rest said out loud
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("branches feat/b0, feat/b1, feat/b2 and 2 more ·");
  });

  test("many live sessions on one branch are one branch", () => {
    const lines = presenceLines([0, 1, 2, 3].map((index) => live(index, "feat/x")));

    expect(lines).toEqual([
      "- Nick · branch feat/x · status analyzing · heartbeat 10s ago",
    ]);
  });

  test("the status shown is the highest-ranked one on the freshest branch", () => {
    // The freshest session on feat/x is analyzing; an older one on the same
    // branch is implementing. A session on another branch says testing, and
    // is not the freshest topic's — so it does not speak for the line.
    const lines = presenceLines([
      live(0, "feat/x"),
      live(1, "feat/x", { status: "implementing" }),
      live(2, "feat/y", { status: "testing" }),
    ]);

    expect(lines[0]).toContain("· status implementing ·");
  });

  test("the grouping counts sessions per branch, for the surfaces that print them", () => {
    const [nick] = groupTeammates(
      [live(0, "feat/x"), live(1, "feat/x"), live(2, "feat/y")],
      NOW,
    );

    expect(nick?.sessions).toBe(3);
    expect(nick?.topics.map((topic) => [topic.label, topic.sessions])).toEqual([
      ["feat/x", 2],
      ["feat/y", 1],
    ]);
  });
});
