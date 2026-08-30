/**
 * "Teammate work contexts" is ONE LINE PER TEAMMATE (audit row M15-rest).
 *
 * A work context is created per SESSION, so a teammate with three worktrees —
 * or three restarts on one branch — owned three of them, and a section bounded
 * at MAX_CONTEXTS = 5 lines sorted by age was filled by one person while the
 * teammate working somewhere else never reached the briefing at all.
 */
import { describe, expect, test } from "bun:test";

import { MAX_CONTEXTS } from "../src/constants.ts";
import { groupContextsByDeveloper } from "../src/briefing/context-group.ts";
import { renderBriefing } from "../src/briefing/render.ts";
import type { PresenceEntry, WorkContextEntry } from "../src/http/hub.ts";

const NOW = new Date("2026-08-21T12:00:00.000Z");
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

const render = (contexts: readonly WorkContextEntry[]): string =>
  renderBriefing({
    repoId: "github.com/acme/api",
    selfDeveloperId: "dev_self",
    presence: [presence()],
    workContexts: contexts,
    now: NOW,
  });

const contextLines = (rendered: string): readonly string[] => {
  const start = rendered.indexOf("Teammate work contexts on this repo:");
  expect(start).toBeGreaterThanOrEqual(0);
  return rendered
    .slice(start)
    .split("\n")
    .slice(1)
    .filter((line) => line.startsWith("- "));
};

describe("one line per teammate, not per context", () => {
  test("three contexts of one teammate are one line that says how many", () => {
    // Arrange: Ken, three worktrees, three different pieces of work.
    const rendered = render([
      context({ id: "wc_1", title: "Login 500s on staging", createdAt: minutesAgo(5) }),
      context({ id: "wc_2", title: "Cube rebuild is slow", createdAt: minutesAgo(20) }),
      context({ id: "wc_3", title: "Importer retries forever", createdAt: minutesAgo(40) }),
    ]);

    // Assert: one line, the freshest title, and the two it stands for
    const lines = contextLines(rendered);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("«Login 500s on staging»");
    expect(lines[0]).toContain("2 other pieces of work");
    expect(rendered).not.toContain("«Cube rebuild is slow»");
  });

  test("the same branch open twice is one piece of work, counted once", () => {
    // Two worktrees on the same branch produce the identical title; counting
    // it twice would tell the reader there is more work than there is.
    const lines = contextLines(
      render([
        context({ id: "wc_1", title: "Login 500s on staging", createdAt: minutesAgo(5) }),
        context({ id: "wc_2", title: "Login 500s on staging", createdAt: minutesAgo(9) }),
        context({ id: "wc_3", title: "Cube rebuild is slow", createdAt: minutesAgo(40) }),
      ]),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("1 other piece of work");
    expect(lines[0]).not.toContain("2 other");
  });

  test("the count says what it counts — pieces of work, not contexts", () => {
    // Ken: FOUR eligible contexts under TWO titles, the exact case this
    // module exists for ("three worktrees, or restarting their agent three
    // times on the same branch"). Counting distinct work is the right choice
    // and the doc comment says so; the noun on the line was the untruth. A
    // reader deciding whether to interrupt Ken read "1 more context" and
    // believed he had two sessions open when he had four.
    const lines = contextLines(
      render([
        context({ id: "wc_1", title: "Importer retries forever", createdAt: minutesAgo(3) }),
        context({ id: "wc_2", title: "Importer retries forever", createdAt: minutesAgo(9) }),
        context({ id: "wc_3", title: "Importer retries forever", createdAt: minutesAgo(14) }),
        context({ id: "wc_4", title: "Login 500s on staging", createdAt: minutesAgo(30) }),
      ]),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("1 other piece of work");
    // The number is right; it is the noun that was wrong. "context" is what
    // the reader would have counted rows of, and there are three others.
    expect(lines[0]).not.toContain("more context");
  });

  test("a teammate with one context reads exactly as it did before", () => {
    // The control on the wording: nothing is appended when nothing was folded.
    const lines = contextLines(render([context({ id: "wc_1" })]));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("- Ken, 30m ago, status analyzing: «Login 500s on staging»");
  });

  test("a teammate no longer crowds the section out from under another", () => {
    // THE SYMPTOM, in one test: Ken has five sessions open, Alice one. Before
    // grouping, Ken's five filled MAX_CONTEXTS and Alice was never rendered.
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

    const lines = contextLines(rendered);
    expect(lines).toHaveLength(2);
    expect(rendered).toContain("«Importer retries forever»");
  });
});

describe("which context speaks for the teammate", () => {
  test("a session that recorded something outranks a fresher empty shell", () => {
    // A context is created by STARTING a session, so the freshest one is
    // frequently the one that has done nothing yet.
    const lines = contextLines(
      render([
        context({ id: "wc_new", title: "Just started", createdAt: minutesAgo(1) }),
        context({
          id: "wc_real",
          title: "Login 500s on staging",
          createdAt: minutesAgo(45),
          claimCount: 3,
        }),
      ]),
    );

    expect(lines[0]).toContain("«Login 500s on staging»");
    expect(lines[0]).toContain("45m ago");
  });

  test("captured files count as recorded work, not only claims", () => {
    // Tier-0 capture logs the files a session touched long before anybody
    // publishes a claim; that session is doing real work.
    const lines = contextLines(
      render([
        context({ id: "wc_new", title: "Just started", createdAt: minutesAgo(1) }),
        context({
          id: "wc_real",
          title: "Login 500s on staging",
          createdAt: minutesAgo(45),
          targetCount: 4,
        }),
      ]),
    );

    expect(lines[0]).toContain("«Login 500s on staging»");
  });

  test("with nothing recorded anywhere, the freshest still speaks", () => {
    // The control the two tests above need: substance is a PREFERENCE, and
    // when no row has any, the section behaves exactly as it always did.
    const lines = contextLines(
      render([
        context({ id: "wc_new", title: "Just started", createdAt: minutesAgo(1) }),
        context({ id: "wc_old", title: "Login 500s on staging", createdAt: minutesAgo(45) }),
      ]),
    );

    expect(lines[0]).toContain("«Just started»");
  });

  test("a hub too old to send the counts is read as nothing recorded", () => {
    // Both counts are optional on the wire. An older hub sends neither, and
    // the section must degrade to the freshest rather than to an exception.
    const older = (id: string, title: string, minutes: number): WorkContextEntry => ({
      id,
      developerId: "dev_ken",
      developerName: "Ken",
      title,
      status: "analyzing",
      createdAt: minutesAgo(minutes),
      updatedAt: null,
    });

    const lines = contextLines(
      render([older("wc_new", "Just started", 1), older("wc_old", "Older work", 45)]),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("«Just started»");
    expect(lines[0]).toContain("1 other piece of work");
  });
});

describe("the grouping rules themselves", () => {
  const row = (
    developerId: string,
    title: string,
    ageMs: number,
    hasRecordedWork = false,
  ): {
    developerId: string;
    title: string;
    ageMs: number;
    hasRecordedWork: boolean;
  } => ({ developerId, title, ageMs, hasRecordedWork });

  test("the answer does not depend on the order the rows arrived in", () => {
    // The hub's ORDER BY is activity DESC, but a tolerant list drops rows and
    // a future hub may order differently; grouping must be a function of the
    // set, not of the sequence.
    const rows = [
      row("dev_a", "A newest", 1_000),
      row("dev_a", "A older", 9_000, true),
      row("dev_b", "B only", 4_000),
    ];
    const forwards = groupContextsByDeveloper(rows);
    const backwards = groupContextsByDeveloper([...rows].reverse());

    expect(forwards.map((group) => group.shown.title)).toEqual([
      "B only",
      "A older",
    ]);
    expect(backwards.map((group) => group.shown.title)).toEqual(
      forwards.map((group) => group.shown.title),
    );
    expect(backwards.map((group) => group.otherTitles)).toEqual(
      forwards.map((group) => group.otherTitles),
    );
  });

  test("teammates are ordered freshest first by the row that speaks for them", () => {
    const groups = groupContextsByDeveloper([
      row("dev_a", "A", 5_000),
      row("dev_b", "B", 1_000),
      row("dev_c", "C", 9_000),
    ]);

    expect(groups.map((group) => group.shown.developerId)).toEqual([
      "dev_b",
      "dev_a",
      "dev_c",
    ]);
  });

  test("an empty listing groups to nothing rather than to one empty group", () => {
    expect(groupContextsByDeveloper([])).toEqual([]);
  });
});

describe("the section's own bound", () => {
  test("more teammates than fit are counted by the section, not folded into a line", () => {
    // `total` counts TEAMMATES now. The footer says how many people did not
    // fit; the fold counts on each line say what that person is not showing.
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
