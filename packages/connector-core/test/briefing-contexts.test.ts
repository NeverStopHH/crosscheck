/**
 * "Teammate work contexts" groups a teammate's work by TOPIC.
 *
 * A work context is created per SESSION. The first fix (audit row M15-rest)
 * made the section one line per teammate with "N other pieces of work"; the
 * pilot then showed what that line says at scale: one developer running
 * subagent and worktree sessions owned 471 contexts, and his line read
 * "469 other pieces of work" — a number nobody can act on. A topic is what a
 * reader recognises — the branch a `<branch> @ <repo>` title carries — so many
 * sessions on one branch are one topic with a count and the newest activity.
 */
import { describe, expect, test } from "bun:test";

import {
  MAX_BRIEFING_CHARS,
  MAX_CONTEXTS,
  MAX_TOPICS_PER_TEAMMATE,
} from "../src/constants.ts";
import { groupTopicsByDeveloper } from "../src/briefing/topic-group.ts";
import { renderBriefing } from "../src/briefing/render.ts";
import type { PresenceEntry, WorkContextEntry } from "../src/http/hub.ts";

const NOW = new Date("2026-08-21T12:00:00.000Z");
const REPO_ID = "github.com/acme/api";
const minutesAgo = (minutes: number): string =>
  new Date(NOW.getTime() - minutes * 60_000).toISOString();

const context = (overrides: Partial<WorkContextEntry> = {}): WorkContextEntry => ({
  id: "wc_ken_1",
  developerId: "dev_ken",
  developerName: "Ken",
  title: "Login 500s on staging",
  status: "analyzing",
  createdAt: minutesAgo(30),
  updatedAt: null,
  claimCount: 0,
  targetCount: 0,
  ...overrides,
});

/** N sessions of one teammate on one branch, a minute apart from `first`. */
const sessionsOn = (
  branch: string,
  count: number,
  first: number,
  overrides: Partial<WorkContextEntry> = {},
): readonly WorkContextEntry[] =>
  Array.from({ length: count }, (_unused, index) =>
    context({
      id: `wc_${branch}_${String(index)}`,
      sessionId: `cc_${branch}_${String(index)}`,
      title: `${branch} @ api`,
      createdAt: minutesAgo(first + index),
      ...overrides,
    }),
  );

const presence = (overrides: Partial<PresenceEntry> = {}): PresenceEntry => ({
  sessionId: "cc_ken",
  developerId: "dev_ken",
  developerName: "Ken",
  branch: "feat/auth",
  status: "analyzing",
  lastHeartbeatAt: minutesAgo(1),
  isSelf: false,
  ...overrides,
});

const render = (
  contexts: readonly WorkContextEntry[],
  livePresence: readonly PresenceEntry[] = [presence()],
): string =>
  renderBriefing({
    repoId: REPO_ID,
    selfDeveloperId: "dev_self",
    presence: livePresence,
    workContexts: contexts,
    now: NOW,
  });

/** Every line of the section, indented ones included. */
const sectionLines = (rendered: string): readonly string[] => {
  const start = rendered.indexOf("Teammate work contexts on this repo:");
  expect(start).toBeGreaterThanOrEqual(0);
  const lines = rendered.slice(start).split("\n").slice(1);
  const end = lines.findIndex(
    (line) => !line.startsWith("- ") && !line.startsWith("  ") && !line.startsWith("(+"),
  );
  return end === -1 ? lines : lines.slice(0, end);
};

/** The teammate lines only: one per person. */
const contextLines = (rendered: string): readonly string[] =>
  sectionLines(rendered).filter((line) => line.startsWith("- "));

/** The topic lines under a multi-topic teammate. */
const topicLines = (rendered: string): readonly string[] =>
  sectionLines(rendered).filter((line) => line.startsWith("  - "));

describe("a teammate's work is grouped by topic", () => {
  test("sessions on one branch are one topic with a count and the newest activity", () => {
    // Arrange: Ken, twelve sessions on one branch, a minute apart — the
    // subagent-and-worktree shape the pilot showed.
    const rendered = render(sessionsOn("feat/limiter", 12, 4));

    // Assert: one line, one topic, the count, the FRESHEST age, the branch
    // without the repo label every title in this listing repeats
    expect(sectionLines(rendered)).toEqual([
      "- Ken, 12 sessions, 4m ago, status analyzing: «feat/limiter»",
    ]);
  });

  test("three branches are three topics under one name", () => {
    const rendered = render([
      ...sessionsOn("feat/a", 2, 5),
      ...sessionsOn("feat/b", 1, 20),
      ...sessionsOn("feat/c", 3, 40),
    ]);

    expect(sectionLines(rendered)).toEqual([
      "- Ken, 3 topics, 6 sessions:",
      "  - 2 sessions, 5m ago, status analyzing: «feat/a»",
      "  - 1 session, 20m ago, status analyzing: «feat/b»",
      "  - 3 sessions, 40m ago, status analyzing: «feat/c»",
    ]);
  });

  test("topics beyond the cap are counted, never silently cut", () => {
    // Arrange: two more topics than a teammate's entry shows
    const branches = Array.from(
      { length: MAX_TOPICS_PER_TEAMMATE + 2 },
      (_unused, index) => `feat/t${String(index)}`,
    );
    const rendered = render(
      branches.flatMap((branch, index) => sessionsOn(branch, 1, 10 * (index + 1))),
    );

    // Assert: the freshest ones shown, the rest said out loud
    expect(topicLines(rendered)).toHaveLength(MAX_TOPICS_PER_TEAMMATE);
    expect(topicLines(rendered)[0]).toContain("«feat/t0»");
    expect(sectionLines(rendered)).toContain("  … and 2 more topics");
  });

  test("identical titles minutes apart collapse even without the repo label", () => {
    // A host-supplied title carries no ` @ <repo>`; the same title twice is
    // still one piece of work seen twice.
    const rendered = render([
      context({ id: "wc_1", sessionId: "cc_1", title: "Importer retries forever", createdAt: minutesAgo(3) }),
      context({ id: "wc_2", sessionId: "cc_2", title: "Importer retries forever", createdAt: minutesAgo(9) }),
    ]);

    expect(sectionLines(rendered)).toEqual([
      "- Ken, 2 sessions, 3m ago, status analyzing: «Importer retries forever»",
    ]);
  });

  test("a teammate with one context reads exactly as it did before", () => {
    // The control on the wording: nothing is appended when nothing was folded.
    const lines = contextLines(render([context({ id: "wc_1" })]));

    expect(lines).toEqual(["- Ken, 30m ago, status analyzing: «Login 500s on staging»"]);
  });

  test("a teammate no longer crowds the section out from under another", () => {
    // THE SYMPTOM, in one test: Ken has five topics open, Alice one.
    const kens = [1, 2, 3, 4, 5].map((n) =>
      context({
        id: `wc_ken_${String(n)}`,
        title: `Ken investigation ${String(n)}`,
        createdAt: minutesAgo(n),
      }),
    );
    const rendered = render([
      ...kens,
      context({
        id: "wc_alice",
        developerId: "dev_alice",
        developerName: "Alice",
        title: "Importer retries forever",
        createdAt: minutesAgo(30),
      }),
    ]);

    expect(contextLines(rendered)).toHaveLength(2);
    expect(rendered).toContain("«Importer retries forever»");
  });

  test("two contexts of one session are one session, not two", () => {
    // A recovered session can own a second context; "N sessions" counts
    // sessions, so the reader is not told about a session that never ran.
    const rendered = render([
      context({ id: "wc_1", sessionId: "cc_same", title: "feat/x @ api", createdAt: minutesAgo(2) }),
      context({ id: "wc_2", sessionId: "cc_same", title: "feat/x @ api", createdAt: minutesAgo(8) }),
    ]);

    expect(sectionLines(rendered)).toEqual([
      "- Ken, 2m ago, status analyzing: «feat/x»",
    ]);
  });
});

describe("the status a topic shows", () => {
  test("the most advanced status in a topic is the one shown", () => {
    // The freshest session on the branch is still analyzing; an older one on
    // the same branch is implementing. The topic IS being implemented.
    const rendered = render([
      context({ id: "wc_new", sessionId: "cc_new", title: "feat/x @ api", createdAt: minutesAgo(2) }),
      context({
        id: "wc_old",
        sessionId: "cc_old",
        title: "feat/x @ api",
        status: "implementing",
        createdAt: minutesAgo(20),
      }),
    ]);

    expect(contextLines(rendered)).toEqual([
      "- Ken, 2 sessions, 2m ago, status implementing: «feat/x»",
    ]);
  });

  test("a status this client does not know is never promoted over one it does", () => {
    const rendered = render([
      context({ id: "wc_1", sessionId: "cc_1", title: "feat/x @ api", status: "reticulating", createdAt: minutesAgo(1) }),
      context({ id: "wc_2", sessionId: "cc_2", title: "feat/x @ api", status: "planning", createdAt: minutesAgo(5) }),
    ]);

    expect(contextLines(rendered)[0]).toContain("status planning");
  });

  test("with no known status in the topic, the speaking row's own is shown, never one invented", () => {
    const rendered = render([
      context({ id: "wc_1", sessionId: "cc_1", title: "feat/x @ api", status: "reticulating", createdAt: minutesAgo(1) }),
      context({ id: "wc_2", sessionId: "cc_2", title: "feat/x @ api", status: "splining", createdAt: minutesAgo(5) }),
    ]);

    expect(contextLines(rendered)[0]).toContain("status reticulating");
  });
});

describe("which topic, and which session, speaks first", () => {
  test("a topic with recorded work outranks a fresher empty shell", () => {
    // A context is created by STARTING a session, so the freshest topic is
    // frequently the one that has done nothing yet.
    const rendered = render([
      context({ id: "wc_new", title: "Just started", createdAt: minutesAgo(1) }),
      context({
        id: "wc_real",
        title: "Login 500s on staging",
        createdAt: minutesAgo(45),
        claimCount: 3,
      }),
    ]);

    expect(topicLines(rendered)[0]).toContain("«Login 500s on staging»");
    expect(topicLines(rendered)[0]).toContain("45m ago");
  });

  test("captured files count as recorded work, not only claims", () => {
    const rendered = render([
      context({ id: "wc_new", title: "Just started", createdAt: minutesAgo(1) }),
      context({
        id: "wc_real",
        title: "Login 500s on staging",
        createdAt: minutesAgo(45),
        targetCount: 4,
      }),
    ]);

    expect(topicLines(rendered)[0]).toContain("«Login 500s on staging»");
  });

  test("with nothing recorded anywhere, the freshest topic still leads", () => {
    const rendered = render([
      context({ id: "wc_new", title: "Just started", createdAt: minutesAgo(1) }),
      context({ id: "wc_old", title: "Login 500s on staging", createdAt: minutesAgo(45) }),
    ]);

    expect(topicLines(rendered)[0]).toContain("«Just started»");
  });

  test("inside one topic, the session that recorded something speaks for its intent", () => {
    // Both sessions are on the same branch, so they are one topic; the intent
    // printed under it belongs to the session that did the work, not to the
    // fresher one that has only just started.
    const intent = (summary: string) => ({
      summary,
      provenance: "declared",
      confidence: 0.9,
      capturedAt: minutesAgo(1),
    });
    const rendered = render([
      context({
        id: "wc_new",
        sessionId: "cc_new",
        title: "feat/x @ api",
        createdAt: minutesAgo(1),
        intent: intent("Just looking around"),
      }),
      context({
        id: "wc_real",
        sessionId: "cc_real",
        title: "feat/x @ api",
        createdAt: minutesAgo(30),
        claimCount: 2,
        intent: intent("Stop the importer retrying forever"),
      }),
    ]);

    expect(sectionLines(rendered)).toEqual([
      "- Ken, 2 sessions, 1m ago, status analyzing: «feat/x»",
      "  intent: «Stop the importer retrying forever»",
    ]);
  });

  test("a hub too old to send the counts is read as nothing recorded", () => {
    const older = (id: string, title: string, minutes: number): WorkContextEntry => ({
      id,
      developerId: "dev_ken",
      developerName: "Ken",
      title,
      status: "analyzing",
      createdAt: minutesAgo(minutes),
      updatedAt: null,
    });

    const rendered = render([older("wc_new", "Just started", 1), older("wc_old", "Older work", 45)]);

    expect(contextLines(rendered)).toEqual(["- Ken, 2 topics, 2 sessions:"]);
    expect(topicLines(rendered)[0]).toContain("«Just started»");
  });
});

describe("a count the hub could not complete", () => {
  test("is said as at least, everywhere it appears", () => {
    // Arrange: the hub reports 900 contexts for Ken in the window, and its
    // row bound let three of them through.
    const rendered = render(
      [
        ...sessionsOn("feat/a", 2, 1),
        ...sessionsOn("feat/b", 1, 10),
      ].map((row) => ({ ...row, developerContextCount: 900 })),
    );

    expect(sectionLines(rendered)).toEqual([
      "- Ken, at least 2 topics, at least 3 sessions:",
      "  - at least 2 sessions, 1m ago, status analyzing: «feat/a»",
      "  - at least 1 session, 10m ago, status analyzing: «feat/b»",
    ]);
  });

  test("a single topic the hub could not complete still says it may not be the only one", () => {
    const rendered = render(
      sessionsOn("feat/a", 2, 1).map((row) => ({ ...row, developerContextCount: 40 })),
    );

    expect(contextLines(rendered)).toEqual(["- Ken, at least 1 topic, at least 2 sessions:"]);
  });

  test("the more-topics tail is a lower bound too", () => {
    const branches = Array.from(
      { length: MAX_TOPICS_PER_TEAMMATE + 1 },
      (_unused, index) => `feat/t${String(index)}`,
    );
    const rendered = render(
      branches
        .flatMap((branch, index) => sessionsOn(branch, 1, index + 1))
        .map((row) => ({ ...row, developerContextCount: 50 })),
    );

    expect(sectionLines(rendered)).toContain("  … and at least 1 more topic");
  });

  test("a listing the hub completed never says at least", () => {
    // The control: the hub's count equals what arrived.
    const rows = [...sessionsOn("feat/a", 2, 1), ...sessionsOn("feat/b", 1, 10)];
    const rendered = render(rows.map((row) => ({ ...row, developerContextCount: rows.length })));

    expect(rendered).not.toContain("at least");
    expect(contextLines(rendered)).toEqual(["- Ken, 2 topics, 3 sessions:"]);
  });
});

describe("the grouping rules themselves", () => {
  const row = (
    developerId: string,
    topic: string,
    ageMs: number,
    hasRecordedWork = false,
    sessionKey = `${developerId}:${topic}:${String(ageMs)}`,
    status = "analyzing",
  ) => ({ developerId, topic, ageMs, hasRecordedWork, sessionKey, status });

  test("the answer does not depend on the order the rows arrived in", () => {
    const rows = [
      row("dev_a", "A newest", 1_000),
      row("dev_a", "A older", 9_000, true),
      row("dev_a", "A older", 12_000),
      row("dev_b", "B only", 4_000),
    ];
    const forwards = groupTopicsByDeveloper(rows);
    const backwards = groupTopicsByDeveloper([...rows].reverse());

    const shape = (groups: typeof forwards) =>
      groups.map((group) => ({
        developerId: group.developerId,
        sessions: group.sessions,
        topics: group.topics.map((topic) => [topic.label, topic.sessions, topic.ageMs, topic.status]),
      }));
    expect(shape(backwards)).toEqual(shape(forwards));
    expect(forwards[0]?.topics.map((topic) => topic.label)).toEqual(["A older", "A newest"]);
  });

  test("teammates are ordered by their newest activity", () => {
    const groups = groupTopicsByDeveloper([
      row("dev_a", "A", 5_000),
      row("dev_b", "B", 1_000),
      row("dev_c", "C", 9_000),
    ]);

    expect(groups.map((group) => group.developerId)).toEqual(["dev_b", "dev_a", "dev_c"]);
  });

  test("an empty listing groups to nothing rather than to one empty group", () => {
    expect(groupTopicsByDeveloper([])).toEqual([]);
  });
});

describe("the section's own bound", () => {
  test("more teammates than fit are counted by the section, not folded into a line", () => {
    const contexts = Array.from({ length: MAX_CONTEXTS + 2 }, (_, index) =>
      context({
        id: `wc_${String(index)}`,
        developerId: `dev_${String(index)}`,
        developerName: `Dev${String(index)}`,
        title: `Investigation ${String(index)}`,
        createdAt: minutesAgo(index + 1),
      }),
    );

    const rendered = render(contexts);

    expect(contextLines(rendered)).toHaveLength(MAX_CONTEXTS);
    expect(rendered).toContain("(+2 more not shown)");
  });
});

/**
 * THE PILOT'S SHAPE. Nick: 471 contexts — twelve sessions on the branch he is
 * implementing, two on another, 457 more spread over 47 branches, 470 of them
 * analyzing. Ken: 24 over six branches. Mike: five on one. 500 rows, all
 * inside the hub's 600-row bound, so every count is complete.
 */
const pilotRow = (
  developer: string,
  index: number,
  branch: string,
  minutes: number,
  status: string,
  total: number,
): WorkContextEntry => ({
  id: `wc_${developer}_${String(index)}`,
  sessionId: `cc_${developer}_${String(index)}`,
  developerId: `dev_${developer.toLowerCase()}`,
  developerName: developer,
  title: `${branch} @ monorepo`,
  status,
  createdAt: minutesAgo(minutes),
  updatedAt: null,
  claimCount: 0,
  targetCount: 0,
  developerContextCount: total,
});

const pilotContexts = (): readonly WorkContextEntry[] => [
  ...Array.from({ length: 12 }, (_unused, index) =>
    pilotRow("Nick", index, "feat/deferred-answer-integrity-flow", 5 + index, index === 4 ? "implementing" : "analyzing", 471),
  ),
  pilotRow("Nick", 100, "feat/gc-end-points-3238", 10, "analyzing", 471),
  pilotRow("Nick", 101, "feat/gc-end-points-3238", 25, "analyzing", 471),
  ...Array.from({ length: 457 }, (_unused, index) =>
    pilotRow("Nick", 200 + index, `feat/pilot-topic-${String(index % 47)}`, 30 + 3 * index, "analyzing", 471),
  ),
  ...Array.from({ length: 24 }, (_unused, index) =>
    pilotRow("Ken", index, `fix/ken-${String(index % 6)}`, 20 + 7 * index, index === 0 ? "implementing" : "analyzing", 24),
  ),
  ...Array.from({ length: 5 }, (_unused, index) =>
    pilotRow("Mike", index, "feat/mike-importer", 120 + 10 * index, "implementing", 5),
  ),
];

const WIDE = "w".repeat(60);
const widePresence = (name: string): PresenceEntry =>
  presence({
    sessionId: `cc_live_${name}`,
    developerId: `dev_${name.toLowerCase()}`,
    developerName: name,
    branch: `feat/${name.toLowerCase()}-${WIDE}`,
    status: "implementing",
    intent: {
      summary: `Live work for ${name} ${WIDE}`,
      provenance: "derived",
      confidence: 0.4,
      capturedAt: minutesAgo(1),
    },
  });

describe("the briefing budget with the pilot's 500 contexts", () => {
  const renderPilot = (): string =>
    renderBriefing({
      repoId: "github.com/gamecodeai/monorepo",
      selfDeveloperId: "dev_self",
      presence: ["Nick", "Ken", "Mike"].map(widePresence),
      workContexts: pilotContexts(),
      now: NOW,
    });

  test("stays inside MAX_BRIEFING_CHARS and names every teammate", () => {
    const rendered = renderPilot();

    expect(pilotContexts()).toHaveLength(500);
    expect(rendered.length).toBeLessThanOrEqual(MAX_BRIEFING_CHARS);
    expect(contextLines(rendered)).toEqual([
      "- Nick, 49 topics, 471 sessions:",
      "- Ken, 6 topics, 24 sessions:",
      "- Mike, 5 sessions, 2h ago, status implementing: «feat/mike-importer»",
    ]);
  });

  test("Nick's 471 contexts read as his topics, freshest first, and say how many more", () => {
    const lines = sectionLines(renderPilot());
    const nick = lines.slice(0, lines.indexOf("- Ken, 6 topics, 24 sessions:"));

    expect(nick).toEqual([
      "- Nick, 49 topics, 471 sessions:",
      "  - 12 sessions, 5m ago, status implementing: «feat/deferred-answer-integrity-flow»",
      "  - 2 sessions, 10m ago, status analyzing: «feat/gc-end-points-3238»",
      "  - 10 sessions, 30m ago, status analyzing: «feat/pilot-topic-0»",
      "  … and 46 more topics",
    ]);
  });

  test("at the cap, a teammate who does not fit is counted whole, never cut mid-entry", () => {
    // Arrange: the same 500 rows spread over seven teammates whose every
    // field is at its width — more than the briefing can hold.
    const wideName = (index: number): string => `Teammate ${String(index)} ${"n".repeat(60)}`;
    const contexts = Array.from({ length: 500 }, (_unused, index) => {
      const owner = index % 7;
      return pilotRow(wideName(owner), index, `feat/${String(owner)}-${String(index % 40)}-${"t".repeat(70)}`, 1 + index, "analyzing", 72);
    }).map((row, index) => ({
      ...row,
      developerId: `dev_${String(index % 7)}`,
      developerContextCount: undefined,
    }));

    // Act
    const rendered = renderBriefing({
      repoId: "github.com/gamecodeai/monorepo",
      selfDeveloperId: "dev_self",
      presence: [],
      workContexts: contexts,
      now: NOW,
    });

    // Assert: within the cap, close enough that the cap is what put it there
    expect(rendered.length).toBeLessThanOrEqual(MAX_BRIEFING_CHARS);
    expect(rendered.length).toBeGreaterThan(MAX_BRIEFING_CHARS * 0.8);
    // every teammate is either shown or counted
    const shown = contextLines(rendered).length;
    const hidden = Number(/^\(\+(\d+) more not shown\)$/m.exec(rendered)?.[1] ?? "0");
    expect(shown).toBeGreaterThan(0);
    expect(shown + hidden).toBe(7);
    // and every entry that IS shown carries its own tail, so none was cut
    const lines = sectionLines(rendered);
    expect(lines.filter((line) => line.startsWith("  … and "))).toHaveLength(shown);
  });
});
