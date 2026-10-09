/**
 * NO AGE FOR A TEAMMATE WHO OPTED OUT (batch-2 integration review, M5; the
 * realistic gate's P2.anonymous.when.briefing). The hub withholds her last
 * touch (`updatedAt`) and marks the row `locationWithheld`; the briefing's
 * topic line then fell back to `createdAt`, and a topic context minted the
 * moment she first edited a sibling worktree read "Mike, 2s ago". Opting out
 * hides WHEN: the line keeps her name, her status and the work's title, and
 * prints no age — for one topic and for a list of them alike.
 */
import { describe, expect, test } from "bun:test";

import { renderBriefing } from "../src/briefing/render.ts";
import type { WorkContextEntry } from "../src/http/hub.ts";

const NOW = new Date("2026-10-09T12:00:00.000Z");
const secondsAgo = (seconds: number): string => new Date(NOW.getTime() - seconds * 1000).toISOString();
const AGE = /\b\d+\s*[smhd]\s+ago\b/;

const context = (overrides: Partial<WorkContextEntry> = {}): WorkContextEntry => ({
  id: "wc_mike_quiet",
  developerId: "dev_mike",
  developerName: "Mike",
  title: "Streaming quiet mode",
  status: "analyzing",
  intent: null,
  createdAt: secondsAgo(2),
  updatedAt: null,
  ...overrides,
});

const entryLines = (workContexts: readonly WorkContextEntry[]): readonly string[] =>
  renderBriefing({
    repoId: "github.com/acme/api",
    selfDeveloperId: "dev_self",
    presence: [],
    workContexts,
    now: NOW,
  })
    .split("\n")
    .filter((line) => line.trimStart().startsWith("- "));

describe("an opted-out teammate's work is listed without an age", () => {
  test("a row the hub marked withheld names the work and its status, and no age", () => {
    // Arrange: her last touch withheld, so only the creation instant is left on the row
    const lines = entryLines([context({ locationWithheld: true })]);

    // Assert
    expect(lines).toEqual(["- Mike, status analyzing: «Streaming quiet mode»"]);
  });

  test("a row the hub did not mark keeps its age, read from the same instant", () => {
    // Arrange
    const lines = entryLines([context()]);

    // Assert
    expect(lines).toEqual(["- Mike, 2s ago, status analyzing: «Streaming quiet mode»"]);
  });

  test("several withheld topics of hers are listed, each without an age", () => {
    // Arrange: two topics, two sessions — the listed shape, with a head line
    const lines = entryLines([
      context({ id: "wc_mike_a", title: "Streaming quiet mode", sessionId: "cc_mike_a", locationWithheld: true }),
      context({ id: "wc_mike_b", title: "Mapping grid api", sessionId: "cc_mike_b", createdAt: secondsAgo(40), locationWithheld: true }),
    ]);

    // Assert: her work is there, and nothing on any line says when
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines[0]).toStartWith("- Mike, 2 topics, 2 sessions:");
    expect(lines.filter((line) => AGE.test(line))).toEqual([]);
  });

  test("a withheld row beside a teammate's dated one changes nothing about his", () => {
    // Arrange
    const lines = entryLines([
      context({ locationWithheld: true }),
      context({ id: "wc_ken", developerId: "dev_ken", developerName: "Ken", title: "Key rotation", createdAt: secondsAgo(90) }),
    ]);

    // Assert
    expect(lines).toContain("- Mike, status analyzing: «Streaming quiet mode»");
    expect(lines).toContain("- Ken, 1m ago, status analyzing: «Key rotation»");
  });
});
