/**
 * The hint and tripwire surfaces (03 §3.5, §5.1).
 *
 * TWO RULINGS THIS FILE PINS, because the spec's list did not settle either.
 *
 * 1. A SILENT PATH STAYS SILENT. §5.1 forbids EMITTING an empty-result
 *    phrasing over a gap; it does not compel speech where there was none.
 *    `selectAndRenderHint` returns "" from eight branches, and turning those
 *    into a coverage line would put an unsolicited sentence on every prompt
 *    of every repo with a gap — the noise §5.1 itself argues against, inside
 *    an 800 ms budget that binds.
 *
 * 2. THE CLAUSE NEVER COSTS THE HINT. `fitHint` drops from the TAIL and
 *    returns "" below two kept lines, so a clause appended blindly is either
 *    the first casualty or pushes the hint under the floor — a silence
 *    nobody asked for. It is appended only when the whole thing still fits.
 */
import { describe, expect, test } from "bun:test";

import { MAX_HINT_TEXT_LENGTH } from "@crosscheck/schema";
import { renderTripwireReason, withCoverageNote } from "../src/hints/render.ts";
import { UNKNOWN_COVERAGE } from "../src/http/coverage.ts";
import type { CoverageRecord } from "../src/http/coverage.ts";

const NOW = new Date("2026-09-15T10:00:00.000Z");
const GAP_ISO = "2026-09-05T08:13:00.000Z";
const GAP_SHOWN = "2026-09-05T08:13Z";

const reaped = (): CoverageRecord => ({
  repo: "github.com/acme/api",
  computedAt: NOW.toISOString(),
  scope: { sinceIso: GAP_ISO },
  sources: [
    { source: "agent_event", state: "incomplete", reason: "session_reaped", gapSince: GAP_ISO, observedAt: GAP_ISO },
    { source: "git", state: "complete", reason: "commits_reported", gapSince: null, observedAt: GAP_ISO },
    { source: "ci", state: "unavailable", reason: "no_emitter", gapSince: null, observedAt: null },
    { source: "runtime", state: "unavailable", reason: "out_of_scope_1_0", gapSince: null, observedAt: null },
    { source: "human_edit", state: "unavailable", reason: "no_platform_rung", gapSince: null, observedAt: null },
  ],
});

describe("a hint that speaks says how far the archive reached", () => {
  test("an incomplete rung appends the clause", () => {
    // Act
    const hinted = withCoverageNote("crosscheck: a line\nand another", reaped(), NOW);

    // Assert
    expect(hinted).toContain(GAP_SHOWN);
    expect(hinted.startsWith("crosscheck: a line")).toBe(true);
  });

  test("an un-upgraded hub appends nothing — the soft rule, decision 4", () => {
    // Act
    const hinted = withCoverageNote("crosscheck: a line\nand another", UNKNOWN_COVERAGE, NOW);

    // Assert
    expect(hinted).toBe("crosscheck: a line\nand another");
  });

  test("a silent path stays silent", () => {
    // Act & Assert: nothing was going to be said, and a caveat on nothing is
    // an unsolicited sentence on every prompt of every repo with a gap.
    expect(withCoverageNote("", reaped(), NOW)).toBe("");
  });

  test("the clause is dropped rather than the hint when the cap is tight", () => {
    // Arrange: a hint filling the wire cap to within a few characters
    const hint = `a${"x".repeat(MAX_HINT_TEXT_LENGTH - 2)}b`;

    // Act
    const hinted = withCoverageNote(hint, reaped(), NOW);

    // Assert
    expect(hinted).toBe(hint);
    expect(hinted.length).toBeLessThanOrEqual(MAX_HINT_TEXT_LENGTH);
  });
});

describe("the tripwire reason carries it too", () => {
  const session = {
    sessionId: "cc_11111111-2222-4333-8444-555555555555",
    developerId: "dev_other",
    developerName: "Robin",
    branch: "feat/playback",
    status: "implementing",
    lastHeartbeatAt: "2026-09-15T09:55:00.000Z",
    workContextId: "wc_cc_11111111-2222-4333-8444-555555555555",
    workContextTitle: "Playback stalls on seek",
    workContextIntent: null,
  };

  test("an incomplete rung reaches the PreToolUse ask reason", () => {
    // Act
    const rendered = renderTripwireReason(session, "src/player.ts", NOW, reaped());

    // Assert
    expect(rendered).toContain(GAP_SHOWN);
  });

  test("an un-upgraded hub leaves the ask reason exactly as it was", () => {
    // Act
    const rendered = renderTripwireReason(session, "src/player.ts", NOW, UNKNOWN_COVERAGE);

    // Assert
    expect(rendered).not.toContain("Coverage");
  });
});
