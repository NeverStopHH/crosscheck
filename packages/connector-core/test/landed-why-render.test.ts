/**
 * THE WHY, AS THE STOP SAYS IT (docs/1.0/landed-changes.md, step 3).
 *
 * Under the landed commits a stop names, each teammate work context the hub
 * matched gets the live half's shape: a pointer (title, readable with
 * get_diagnosis <id>) and the intent — decisions and rejected approaches stay
 * one get_diagnosis away (pointers proactive, substance pulled). A probable
 * match said as one: "work on this file before it landed", never "the reason
 * for this commit" (decision 6). No match, no line: the stop never says "no
 * reason recorded".
 */
import { describe, expect, test } from "bun:test";

import { QUOTED_DATA_NOTICE } from "../src/briefing/render.ts";
import { renderEditWarning } from "../src/hints/render.ts";
import type { LandedContextMatch } from "../src/http/hub.ts";
import type { LandedChanges, LandedCommit } from "../src/landed-changes/probe.ts";

const NOW = new Date("2026-09-25T12:00:00Z");
const FILE = "src/lines.ts";

const commit = (overrides: Partial<LandedCommit> = {}): LandedCommit => ({
  sha: "0dcfc4e41e1f309f8a6d3056726744bb8ddd6133",
  shortSha: "0dcfc4e",
  authorName: "Mike",
  authorEmail: "mike@example.com",
  subject: "Fix line offset",
  committedAt: new Date("2026-09-25T10:00:00Z"),
  branches: ["staging"],
  landedAt: null,
  ...overrides,
});

const missing = (commits: readonly LandedCommit[]): LandedChanges => ({
  missing: commits,
  recent: [],
  moreMissing: false,
  unchecked: [],
  cleanKey: null,
});

const match = (overrides: Partial<LandedContextMatch> = {}): LandedContextMatch => ({
  sha: "0dcfc4e41e1f309f8a6d3056726744bb8ddd6133",
  workContextId: "wc_mike",
  title: "Line offsets are off by one",
  developerName: "Mike",
  intent: {
    summary: "Make line offsets one-based everywhere",
    provenance: "declared",
    confidence: 1,
    capturedAt: "2026-09-25T09:00:00.000Z",
  },
  ...overrides,
});

const render = (why: readonly LandedContextMatch[], commits: readonly LandedCommit[] = [commit()]): string =>
  renderEditWarning({ live: null, landed: missing(commits), file: FILE, now: NOW, why });

describe("the teammate work behind a landed change", () => {
  test("is named under the commits, as work on this file before it landed, with its intent", () => {
    const lines = render([match()]).split("\n");

    const pointer = lines.findIndex((line) => line.startsWith("Mike's work on src/lines.ts before it landed"));
    expect(pointer).toBeGreaterThan(lines.findIndex((line) => line.includes("git show 0dcfc4e")));
    expect(lines[pointer]).toBe(
      "Mike's work on src/lines.ts before it landed: work context «Line offsets are off by one», " +
        "readable with get_diagnosis wc_mike.",
    );
    // A declared intent carries no qualifier; only a derived one says so.
    expect(lines[pointer + 1]).toBe("Their intent: «Make line offsets one-based everywhere»");
    expect(lines.at(-1)).toBe(QUOTED_DATA_NOTICE);
  });

  test("never claims to be the reason for the commit", () => {
    const text = render([match()]);

    expect(text).not.toMatch(/reason for|because of|why this commit/i);
  });

  test("one work context behind two commits is named once", () => {
    const second = commit({ sha: "1".repeat(40), shortSha: "1111111", subject: "Follow-up" });

    const text = render([match(), match({ sha: second.sha })], [commit(), second]);

    expect(text.split("get_diagnosis wc_mike")).toHaveLength(2);
  });

  test("at most two work contexts are named", () => {
    const text = render([
      match({ workContextId: "wc_one" }),
      match({ workContextId: "wc_two", developerName: "Ken" }),
      match({ workContextId: "wc_three", developerName: "Robin" }),
    ]);

    expect(text).toContain("get_diagnosis wc_one");
    expect(text).toContain("get_diagnosis wc_two");
    expect(text).not.toContain("wc_three");
  });

  test("a work context with no intent is still named, without an intent line", () => {
    const text = render([match({ intent: null })]);

    expect(text).toContain("get_diagnosis wc_mike");
    expect(text).not.toContain("Their intent");
  });

  test("no match leaves the stop exactly as it was — no 'no reason' line", () => {
    const without = renderEditWarning({ live: null, landed: missing([commit()]), file: FILE, now: NOW });

    expect(render([])).toBe(without);
    expect(render([])).not.toMatch(/no (reason|work context)/i);
  });

  test("each line carries at most one quoted value", () => {
    const text = render([match()]);

    for (const line of text.split("\n").filter((l) => l.includes("before it landed") || l.startsWith("Their intent"))) {
      expect(line.split("«").length - 1).toBeLessThanOrEqual(1);
    }
  });

  test("no landed change, no why — whatever the hub said", () => {
    expect(renderEditWarning({ live: null, landed: null, file: FILE, now: NOW, why: [match()] })).toBe("");
  });
});
