/**
 * The ghost-check line and its briefing block (VISION.md §3).
 *
 * What is under test is mostly what the line REFUSES to say. It names the
 * reader's own file paths back at them (safe: the hub only ever sends the
 * intersection), but never the teammate's other files, never a claim body,
 * and never the 39 characters of a fingerprint hash — a shared failure is a
 * fact a tired human can act on, a hash is not. And a row with no reason a
 * reader could check is dropped rather than printed as a name with a warning
 * attached, which is the whole difference between this and prediction
 * theatre.
 */
import { describe, expect, test } from "bun:test";

import { formatGhostLine } from "../src/briefing/ghost.ts";
import { renderBriefing } from "../src/briefing/render.ts";
import { MAX_GHOST_POINTERS } from "../src/constants.ts";
import type { GhostCheckEntry } from "../src/http/hub.ts";

const NOW = new Date("2026-08-18T12:00:00.000Z");
const FIVE_MINUTES_AGO = "2026-08-18T11:55:00.000Z";
const FINGERPRINT = "sha256:0f1e2d3c4b5a69788796a5b4c3d2e1f0";

const ghostCheck = (
  overrides: Partial<GhostCheckEntry> = {},
): GhostCheckEntry => ({
  workContextId: "wc_theirs",
  title: "Session store migration",
  developerId: "dev_ken",
  developerName: "Ken",
  intent: {
    summary: "Move the session store behind an interface",
    provenance: "declared",
    confidence: 1,
    capturedAt: FIVE_MINUTES_AGO,
  },
  lastActiveAt: FIVE_MINUTES_AGO,
  sharedTargets: [
    { kind: "file", value: "src/auth/session.ts" },
    { kind: "file", value: "src/auth/token.ts" },
  ],
  sharedTargetCount: 2,
  intentTokenHits: 0,
  ...overrides,
});

const framePairs = (text: string): number => {
  const opens = text.split("«").length - 1;
  const closes = text.split("»").length - 1;
  expect(opens).toBe(closes);
  return opens;
};

describe("the ghost-check line", () => {
  test("names who, since when, which of my files, and the call", () => {
    const line = formatGhostLine(ghostCheck(), NOW);
    expect(line).toBe(
      "- Ken · last active 5m ago · also on src/auth/session.ts, src/auth/token.ts · " +
        "intent: «Move the session store behind an interface» · get_diagnosis wc_theirs",
    );
    expect(framePairs(line ?? "")).toBe(1);
  });

  test("a shared failure is a fact, never the hash", () => {
    const line = formatGhostLine(
      ghostCheck({
        sharedTargets: [
          { kind: "error_fingerprint", value: FINGERPRINT },
          { kind: "file", value: "src/auth/token.ts" },
        ],
        sharedTargetCount: 2,
      }),
      NOW,
    );
    expect(line).toContain("hit the same failure");
    expect(line).not.toContain(FINGERPRINT);
    expect(line).not.toContain("sha256");
    // The control: the file beside it IS named, so what suppressed the hash
    // is the kind and not a blanket refusal to print shared values.
    expect(line).toContain("also on src/auth/token.ts");
  });

  test("the overlap the sample does not fit is stated, not implied", () => {
    const line = formatGhostLine(
      ghostCheck({
        sharedTargets: [
          { kind: "file", value: "a.ts" },
          { kind: "file", value: "b.ts" },
          { kind: "file", value: "c.ts" },
        ],
        sharedTargetCount: 7,
      }),
      NOW,
    );
    expect(line).toContain("also on a.ts, b.ts, c.ts (+4 more of yours)");
  });

  test("two plans sharing no file still read as one topic", () => {
    const line = formatGhostLine(
      ghostCheck({ sharedTargets: [], sharedTargetCount: 0, intentTokenHits: 4 }),
      NOW,
    );
    expect(line).toContain("same topic as your intent");
    expect(line).not.toContain("also on");
  });

  test("a row with no checkable reason is dropped", () => {
    const reasonless = ghostCheck({
      sharedTargets: [],
      sharedTargetCount: 0,
      intentTokenHits: 0,
    });
    expect(formatGhostLine(reasonless, NOW)).toBeNull();
    // The control: one word of shared intent is a reason, and the identical
    // row then renders. What drops the row above is the missing WHY.
    expect(
      formatGhostLine({ ...reasonless, intentTokenHits: 1 }, NOW),
    ).not.toBeNull();
  });

  test("no intent falls back to the title, and neither costs only the plan", () => {
    const untitled = formatGhostLine(
      ghostCheck({ intent: null, title: "Session store migration" }),
      NOW,
    );
    expect(untitled).toContain("titled «Session store migration»");
    expect(framePairs(untitled ?? "")).toBe(1);

    // A title that sanitizes to nothing keeps the row: the values and the id
    // are still true and still actionable.
    const blank = formatGhostLine(
      ghostCheck({ intent: null, title: "​​" }),
      NOW,
    );
    expect(blank).not.toBeNull();
    expect(framePairs(blank ?? "")).toBe(0);
    expect(blank).toContain("get_diagnosis wc_theirs");
  });

  test("an unparseable timestamp or a bad id drops the row", () => {
    // The control first: the row this test then breaks in two ways does
    // render, so each null below is a refusal rather than an empty renderer.
    expect(formatGhostLine(ghostCheck(), NOW)).not.toBeNull();
    expect(
      formatGhostLine(ghostCheck({ lastActiveAt: "not a date" }), NOW),
    ).toBeNull();
    expect(formatGhostLine(ghostCheck({ workContextId: "«»" }), NOW)).toBeNull();
  });
});

describe("the ghost-check briefing block", () => {
  const briefingWith = (ghostChecks: readonly GhostCheckEntry[]): string =>
    renderBriefing({
      repoId: "github.com/acme/api",
      selfDeveloperId: "dev_self",
      presence: [
        {
          sessionId: "ses_ken",
          developerId: "dev_ken",
          developerName: "Ken",
          branch: "feat/session-store",
          status: "implementing",
          lastHeartbeatAt: FIVE_MINUTES_AGO,
          isSelf: false,
        },
      ],
      workContexts: [
        {
          id: "wc_ambient",
          developerId: "dev_ken",
          developerName: "Ken",
          title: "Ambient teammate context",
          status: "implementing",
          createdAt: FIVE_MINUTES_AGO,
        },
      ],
      ghostChecks,
      now: NOW,
    });

  test("renders after presence and before the ambient contexts", () => {
    const briefing = briefingWith([ghostCheck()]);
    const presenceAt = briefing.indexOf("Teammate sessions active now:");
    const ghostAt = briefing.indexOf("Teammates working on the same things");
    const contextsAt = briefing.indexOf("Ambient teammate context");
    expect(presenceAt).toBeGreaterThanOrEqual(0);
    expect(ghostAt).toBeGreaterThan(presenceAt);
    expect(contextsAt).toBeGreaterThan(ghostAt);
  });

  test("the header says out loud that nothing here blocks", () => {
    expect(briefingWith([ghostCheck()])).toContain("nothing here blocks you");
  });

  test("bounded at MAX_GHOST_POINTERS, and says how many it withheld", () => {
    const many = Array.from(
      { length: MAX_GHOST_POINTERS + 1 },
      (_unused, index) =>
        ghostCheck({ workContextId: `wc_theirs_${String(index)}` }),
    );
    const briefing = briefingWith(many);
    const shown = many.filter((entry) =>
      briefing.includes(`get_diagnosis ${entry.workContextId}`),
    );
    expect(shown.length).toBe(MAX_GHOST_POINTERS);
    expect(briefing).toContain(
      `(+${String(many.length - MAX_GHOST_POINTERS)} more not shown)`,
    );
  });

  test("no overlap renders no section at all", () => {
    // The control: the identical briefing WITH one overlap does carry the
    // header, so the absence below is the empty list and not a dead section.
    expect(briefingWith([ghostCheck()])).toContain(
      "Teammates working on the same things",
    );
    expect(briefingWith([])).not.toContain(
      "Teammates working on the same things",
    );
  });
});
