/**
 * VER-1 and VER-2 — the pair, and the pair is the point (04 §7).
 *
 * The same inputs under a GAP and under COMPLETE coverage must not render the
 * same text. Both name nobody; only one of them is entitled to say that
 * nobody is there. A build where both print "Whatever broke it is not in
 * crosscheck's record" has turned a hole in the archive into an exoneration of
 * every agent session on the repo — and no assertion about the verdict OBJECT
 * would catch it, because the defect is in what a person reads.
 *
 * Plus the three things a renderer of enum words has to get right: a word it
 * knows, a word it does not, and no word at all.
 */
import { describe, expect, test } from "bun:test";

import { VERDICT_BASES } from "@crosscheck/connector-core/http/verdict.ts";
import type { CoverageRecord } from "@crosscheck/connector-core/http/coverage.ts";
import type { SuspectView } from "@crosscheck/connector-core/http/hub.ts";
import type { VerdictView } from "@crosscheck/connector-core/http/verdict.ts";

import { renderSuspect } from "../src/cli/suspect-render.ts";
import {
  KNOWN_BASES,
  NO_VERDICT_FROM_HUB,
  verdictLines,
} from "../src/cli/verdict-render.ts";

/** A FIXED clock. An expiry measured against `Date.now()` drifts by the day. */
const NOW = new Date("2026-09-12T09:00:00.000Z");
const GAP_ISO = "2026-09-05T08:13:00.000Z";
const EXPIRY_ISO = "2026-09-13T09:00:00.000Z";

/** The sentence VER-1 forbids under a gap, quoted from suspect-render.ts. */
const EXONERATION = "Whatever broke it is not in crosscheck's record.";

const COMPLETE: CoverageRecord = {
  repo: "github.com/acme/api",
  computedAt: NOW.toISOString(),
  scope: { sinceIso: GAP_ISO, paths: ["src/player.ts"] },
  sources: [
    { source: "agent_event", state: "complete", reason: "sessions_reported", gapSince: null, observedAt: NOW.toISOString() },
    { source: "git", state: "complete", reason: "commits_reported", gapSince: null, observedAt: NOW.toISOString() },
    { source: "ci", state: "complete", reason: "sessions_reported", gapSince: null, observedAt: NOW.toISOString() },
    { source: "runtime", state: "complete", reason: "sessions_reported", gapSince: null, observedAt: NOW.toISOString() },
    { source: "human_edit", state: "complete", reason: "sessions_reported", gapSince: null, observedAt: NOW.toISOString() },
  ],
};

const GAPPED: CoverageRecord = {
  ...COMPLETE,
  sources: [
    { source: "agent_event", state: "incomplete", reason: "session_reaped", gapSince: GAP_ISO, observedAt: GAP_ISO },
    ...COMPLETE.sources.slice(1),
  ],
};

const verdict = (over: Partial<VerdictView> = {}): VerdictView => ({
  attribution: "INDETERMINATE",
  protection: "unprotected",
  basis: "coverage_gap",
  falsifier: "recorded_break",
  behaviorDelta: "unconfirmed",
  deltaLane: "pin",
  deltaReason: "human_recheck_unrepeated",
  explanationTiming: "absent",
  timingReason: "no_intent",
  invariant: null,
  waiver: null,
  computedAt: NOW.toISOString(),
  ...over,
});

const view = (
  coverage: CoverageRecord,
  verdictView: VerdictView | null,
): SuspectView => ({
  outcome: "no_touch",
  falsifier: { kind: "recorded_break", at: GAP_ISO, check: "bun test auth" },
  scope: {
    kind: "pin",
    pinId: "pin_11111111-2222-4333-8444-555555555555",
    surface: "playback keeps working",
    files: ["src/player.ts"],
    missingFiles: [],
    rewrittenPaths: 0,
    rewrittenAt: null,
  },
  totals: { sessionsTouching: 0, sessionsScored: 0, windowDays: 14 },
  attribution: "sessions",
  candidates: [],
  coverage,
  verdict: verdictView,
});

describe("VER-1 / VER-2 — the same absence, two entitlements", () => {
  test("under a GAP, nobody is exonerated and the gap instant is printed", () => {
    // Arrange & Act: one reaped session, a pin recorded broken, zero touching
    const rendered = renderSuspect(view(GAPPED, verdict()), NOW);

    // Assert
    expect(rendered).not.toContain(EXONERATION);
    expect(rendered).toContain(GAP_ISO.slice(0, 16));
    expect(rendered).toContain("INDETERMINATE");
    expect(rendered).toContain("an absence of sessions is not evidence");
  });

  test("under COMPLETE coverage the same absence DOES exonerate", () => {
    // Arrange & Act: identical fixture, five sources complete
    const rendered = renderSuspect(
      view(
        COMPLETE,
        verdict({ attribution: "UNATTRIBUTED", basis: "no_touch_complete" }),
      ),
      NOW,
    );

    // Assert
    expect(rendered).toContain(EXONERATION);
    expect(rendered).toContain("UNATTRIBUTED");
  });

  test("the two renderings differ — a build where they agree has the bug", () => {
    // Arrange & Act
    const gapped = renderSuspect(view(GAPPED, verdict()), NOW);
    const complete = renderSuspect(
      view(
        COMPLETE,
        verdict({ attribution: "UNATTRIBUTED", basis: "no_touch_complete" }),
      ),
      NOW,
    );

    // Assert
    expect(gapped).not.toBe(complete);
  });

  test("a missing pinned path suppresses it too — a zero about the pin", () => {
    // Arrange & Act
    const rendered = renderSuspect(
      view(COMPLETE, verdict({ basis: "pin_paths_missing" })),
      NOW,
    );

    // Assert
    expect(rendered).not.toContain(EXONERATION);
  });
});

describe("an absent verdict is said, never silent", () => {
  test("the surface prints what it does not know", () => {
    // Arrange & Act: an un-upgraded 1.0 hub
    const rendered = renderSuspect(view(COMPLETE, null), NOW);

    // Assert
    expect(rendered).toContain(NO_VERDICT_FROM_HUB);
  });

  test("and it does NOT silently suppress the outcome sentence", () => {
    // Arrange — Principle 5 in the other direction. A hub that reports no
    // verdict told us nothing about coverage either, so withholding the
    // outcome on top of the missing verdict makes the surface say LESS than
    // the hub actually knows.
    const rendered = renderSuspect(view(COMPLETE, null), NOW);

    // Assert
    expect(rendered).toContain(EXONERATION);
  });
});

describe("the block's placement is the argument", () => {
  test("the verdict prints ABOVE the falsifier lines", () => {
    // Arrange
    const rendered = renderSuspect(view(GAPPED, verdict()), NOW);

    // Act
    const verdictAt = rendered.indexOf("verdict: INDETERMINATE");
    const falsifierAt = rendered.indexOf("falsified:");

    // Assert — a reader who meets the rows first has already read them as an
    // accusation by the time the qualification arrives.
    expect(verdictAt).toBeGreaterThan(-1);
    expect(falsifierAt).toBeGreaterThan(verdictAt);
  });
});

describe("protection is printed only when it says something", () => {
  test("unprotected prints NOTHING, and no out-of-date warning", () => {
    // Arrange & Act
    const lines = verdictLines(verdict({ protection: "unprotected" }), NOW);

    // Assert — the silent value must not reach the unknown-word branch
    expect(lines.join("\n")).not.toContain("no sentence for that word");
    expect(lines.some((line) => line.includes("human-verified"))).toBe(false);
  });

  test("PROTECTED CONFLICT is printed in words a reader cannot skim past", () => {
    // Arrange & Act
    const lines = verdictLines(
      verdict({ protection: "PROTECTED_CONFLICT" }),
      NOW,
    );

    // Assert
    expect(lines.join("\n")).toContain("PROTECTED CONFLICT");
    expect(lines.join("\n")).toContain("no waiver covers it");
  });

  test("a live waiver names the person and the deadline BEFORE the reason", () => {
    // Arrange & Act
    const lines = verdictLines(
      verdict({
        protection: "protected_ok",
        waiver: {
          id: "fw_1",
          pinVersion: 1,
          expiresAt: EXPIRY_ISO,
          reason: "Rollout is blocked; the fix lands Monday",
          grantedByName: "Nick",
        },
      }),
      NOW,
    );
    const text = lines.join("\n");

    // Assert
    expect(text).toContain("fence opened by Nick");
    expect(text).toContain(EXPIRY_ISO);
    expect(text.indexOf("fence opened by")).toBeLessThan(
      text.indexOf("their reason"),
    );
  });

  test("the reason is FRAMED, and the frame opens once on its line", () => {
    // Arrange — the reason is a teammate's prose reaching a terminal, and
    // « » is the renderer's mark, never the author's.
    const lines = verdictLines(
      verdict({
        protection: "protected_ok",
        waiver: {
          id: "fw_1",
          pinVersion: 1,
          expiresAt: EXPIRY_ISO,
          reason: "Rollout is blocked",
          grantedByName: "Nick",
        },
      }),
      NOW,
    );
    const reasonLine = lines.find((line) => line.includes("their reason"));

    // Assert
    expect(reasonLine).toContain("«Rollout is blocked»");
    expect(reasonLine?.split("«").length).toBe(2);
  });

  test("a waiver with no reason says so rather than framing a blank", () => {
    // Arrange & Act
    const lines = verdictLines(
      verdict({
        protection: "protected_ok",
        waiver: {
          id: "fw_1",
          pinVersion: 1,
          expiresAt: EXPIRY_ISO,
          reason: "",
          grantedByName: "",
        },
      }),
      NOW,
    );
    const text = lines.join("\n");

    // Assert
    expect(text).toContain("no reason recorded");
    expect(text).toContain("a developer this hub did not name");
    expect(text).not.toContain("«»");
  });
});

describe("a word this build does not know", () => {
  test("is printed as a word, with the reason it has no sentence", () => {
    // Arrange & Act: a hub newer than this binary
    const lines = verdictLines(verdict({ basis: "quantum_entangled" }), NOW);

    // Assert
    expect(lines.join("\n")).toContain("quantum_entangled");
    expect(lines.join("\n")).toContain(
      "the hub may be newer than this install",
    );
  });

  test("an unknown attribution does not cost the rest of the block", () => {
    // Arrange & Act
    const lines = verdictLines(
      verdict({ attribution: "MOSTLY_SURE", basis: "separated" }),
      NOW,
    );

    // Assert — the basis sentence still renders
    expect(lines.join("\n")).toContain("one session stands clear");
  });
});

/**
 * A basis the hub can send and this renderer has no sentence for would print
 * "the hub may be newer than this install" on a value this build DOES know —
 * which reads to a user as a hub problem when it is a missing line here. The
 * expected set is derived from the wire vocabulary, never written down.
 */
describe("every basis the wire admits has a sentence", () => {
  test("the sentence map covers VERDICT_BASES exactly", () => {
    expect([...KNOWN_BASES].sort()).toEqual([...VERDICT_BASES].sort());
  });
});
