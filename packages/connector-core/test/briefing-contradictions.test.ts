/**
 * Contradiction pointers in the SessionStart briefing (VISION.md §4
 * discovery): ONE LINE per open contradiction, naming who disagrees and the
 * tool + id that reads the case file — never the case file itself. That is
 * the existing pointer discipline: unverified or heavyweight content is
 * pulled deliberately, not injected (DESIGN.md §4).
 *
 * Every field on a pointer line is teammate-writable, so the three untrusted
 * classes apply: names and kinds/statuses BARE, the cx_ id through the id
 * allowlist, no prose at all — pointer lines carry no « » body on purpose.
 */
import { describe, expect, test } from "bun:test";

import { MAX_BRIEFING_CHARS, renderBriefing } from "../src/index.ts";
import { MAX_CONTRADICTION_POINTERS } from "../src/constants.ts";
import type { ContradictionEntry } from "../src/http/hub.ts";

const NOW = new Date("2026-08-10T12:00:00.000Z");

const contradictionEntry = (
  overrides: Partial<ContradictionEntry> = {},
): ContradictionEntry => ({
  id: "cx_0123456789abcdef0123456789abcdef",
  claimA: {
    id: "clm_a",
    workContextId: "wc_a",
    kind: "hypothesis",
    status: "proposed",
    authorDeveloperName: "Nick",
  },
  claimB: {
    id: "clm_b",
    workContextId: "wc_b",
    kind: "hypothesis",
    status: "rejected",
    authorDeveloperName: "Robin",
  },
  reason: "shared_target",
  similarity: null,
  ...overrides,
});

const render = (
  contradictions: readonly ContradictionEntry[] | undefined,
): string =>
  renderBriefing({
    repoId: "github.com/acme/api",
    selfDeveloperId: "dev_self",
    presence: [],
    workContexts: [],
    now: NOW,
    contradictions,
  });

describe("briefing contradiction pointers", () => {
  test("one line per contradiction: who disagrees, and the tool call that reads the case file", () => {
    // Act
    const briefing = render([contradictionEntry()]);

    // Assert
    expect(briefing).toContain("Conflicting positions");
    expect(briefing).toContain(
      "- Nick (hypothesis, proposed) vs Robin (hypothesis, rejected) · get_referee_brief cx_0123456789abcdef0123456789abcdef",
    );
    // Pointer discipline: never the bodies — there are none on the wire here,
    // and no « » frame opens on any pointer line (the document header's
    // quoted-data notice is the only place the guillemets appear)
    for (const line of briefing.split("\n").slice(1)) {
      expect(line.includes("«"), line).toBe(false);
    }
  });

  test("renders no section at all when the hub reports no contradictions", () => {
    // Act + Assert
    expect(render([])).toBe("");
    expect(render(undefined)).toBe("");
  });

  test("caps pointers and counts the hidden rest", () => {
    // Arrange
    const many = Array.from({ length: MAX_CONTRADICTION_POINTERS + 2 }, (_, i) =>
      contradictionEntry({ id: `cx_${String(i).repeat(32).slice(0, 32)}` }),
    );

    // Act
    const briefing = render(many);

    // Assert: pointer LINES, not the section header, which names the tool too
    const pointerLines = briefing
      .split("\n")
      .filter(
        (line) => line.startsWith("- ") && line.includes("get_referee_brief"),
      );
    expect(pointerLines.length).toBe(MAX_CONTRADICTION_POINTERS);
    expect(briefing).toContain("(+2 more not shown)");
  });

  test("pointer sides order canonically by claim id, never by the hub's pair order", () => {
    // Arrange: the hub happens to list Zoe's side first, but her claim id
    // sorts second — who is NAMED FIRST must not be the hub's (or the derived
    // query's open-side-first) choice, for the same reason the brief assigns
    // its A/B labels canonically
    const entry = contradictionEntry({
      claimA: {
        id: "clm_z",
        workContextId: "wc_a",
        kind: "hypothesis",
        status: "proposed",
        authorDeveloperName: "Zoe",
      },
      claimB: {
        id: "clm_a",
        workContextId: "wc_b",
        kind: "hypothesis",
        status: "rejected",
        authorDeveloperName: "Amy",
      },
    });

    // Act
    const briefing = render([entry]);

    // Assert
    expect(briefing).toContain(
      "- Amy (hypothesis, rejected) vs Zoe (hypothesis, proposed) · get_referee_brief cx_0123456789abcdef0123456789abcdef",
    );
  });

  test("a hostile id is reduced by the allowlist, and an empty survivor drops the line", () => {
    // Arrange: the id prints BARE next to a tool name, so it goes through the
    // same allowlist as every other id — a frame pair in it must vanish
    const hostile = contradictionEntry({ id: "«cx_evil»" });
    const emptied = contradictionEntry({ id: "«»" });

    // Act
    const briefing = render([hostile]);
    const dropped = render([emptied]);

    // Assert
    const hostileLine = briefing
      .split("\n")
      .find((line) => line.startsWith("- "));
    expect(hostileLine).toContain("get_referee_brief cx_evil");
    expect(hostileLine?.includes("«")).toBe(false);
    expect(dropped).toBe("");
  });

  test("unnamed authors fall back honestly and the line stays inside the budget", () => {
    // Arrange
    const anonymous = contradictionEntry({
      claimA: {
        id: "clm_a",
        workContextId: "wc_a",
        kind: "root_cause",
        status: "likely_root_cause",
      },
    });

    // Act
    const briefing = render([anonymous]);

    // Assert
    expect(briefing).toContain("a teammate (root_cause, likely_root_cause)");
    expect(briefing.length).toBeLessThanOrEqual(MAX_BRIEFING_CHARS);
  });
});
