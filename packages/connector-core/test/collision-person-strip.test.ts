/**
 * WHAT A PERSON'S LINE MAY NOT CARRY, ROUND TWO (review of
 * feat/collision-visible, round 2, L5). The first round stripped the colon and
 * dash lookalikes it had listed; the reviewer found more NFKC leaves alone —
 * colons U+02D0 U+02F8 U+05C3 U+1804, dashes U+2012 U+2E3A U+2500, the dot
 * operators U+2219 U+22C5 U+30FB that stand in for the statusline's `·` — and
 * markdown emphasis and bare `www.` autolinks a markdown host would render.
 * Each would let a teammate's name, branch or file name mint a second verdict
 * on a line the person trusts. The renderer's own words are left alone: only
 * code points no field may carry are checked, and the ordinary characters of
 * real names, branches and files are pinned to survive.
 */
import { describe, expect, test } from "bun:test";

import { ghostCollisions, renderCollisionNotice, renderOverlapIndicator, tripwireCollision } from "../src/hints/collision-notice.ts";
import type { GhostCheckEntry, TripwireSession } from "../src/http/hub.ts";
import { INJECTION_CORPUS } from "./fixtures/injection-corpus.ts";

const NOW = new Date("2026-10-07T12:00:00.000Z");

const row = (overrides: Partial<TripwireSession> = {}): TripwireSession => ({
  sessionId: "cc_mike",
  developerId: "dev_mike",
  developerName: "Mike",
  branch: "feat/refresh-fix",
  status: "implementing",
  lastHeartbeatAt: "2026-10-07T11:59:00.000Z",
  workContextId: "wc_mike",
  workContextTitle: "t",
  workContextIntent: null,
  ...overrides,
});

const ghost = (name: string, file: string): GhostCheckEntry => ({
  workContextId: "wc_ghost",
  title: "t",
  developerId: "dev_ghost",
  developerName: name,
  intent: null,
  lastActiveAt: "2026-10-05T12:00:00.000Z",
  sharedTargets: [{ kind: "file", value: file }],
  sharedTargetCount: 1,
  intentTokenHits: 0,
});

/** Built from numbers, like the renderer's own list, so no lookalike sits in this file. */
const LOOKALIKES = String.fromCodePoint(0x02d0, 0x02f8, 0x05c3, 0x1804, 0x2012, 0x2e3a, 0x2500, 0x2219, 0x22c5, 0x30fb);

/** Emphasis or strikethrough: `*` and `~` anywhere, `_` that is not inside a word. */
const EMPHASIS = /[*~]|(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/u;

const AUTOLINK = /(^|[\s_])www\./iu;

/** Every surface a teammate's field reaches on the person's screen, for one payload. */
const personSurfaces = (payload: string): readonly string[] => {
  const asName = tripwireCollision(row({ developerName: payload }), "src/a.ts");
  const asBranch = tripwireCollision(row({ branch: payload }), "src/a.ts");
  const asFile = tripwireCollision(row(), `src/${payload}`);
  const asGhost = ghostCollisions([ghost(payload, payload)]);
  return [
    ...[asName, asBranch, asFile, ...asGhost].map((group) => renderCollisionNotice(group, NOW)),
    renderOverlapIndicator([asName], [{ developerId: asName.developerId, isSelf: false }]),
  ];
};

describe("a person's line drops the round-two lookalikes and markdown", () => {
  test.each(["colon-lookalikes-modifier", "dash-lookalikes-figure", "dot-operator-lookalikes", "markdown-emphasis", "bare-www-autolink"])(
    "%s leaves no lookalike separator, emphasis marker or bare autolink in a name, a branch or a file name",
    (id) => {
      // Arrange
      const payload = INJECTION_CORPUS.find((entry) => entry.id === id)?.payload ?? "";

      // Act
      const surfaces = personSurfaces(payload);

      // Assert
      expect(payload.length).toBeGreaterThan(0);
      for (const text of surfaces) {
        expect([...text].filter((point) => LOOKALIKES.includes(point)), `${id}: ${text}`).toEqual([]);
        expect(EMPHASIS.test(text), `${id}: ${text}`).toBe(false);
        expect(AUTOLINK.test(text), `${id}: ${text}`).toBe(false);
      }
    },
  );

  test("a separator lookalike becomes a space, so the words either side stay two words", () => {
    // Arrange: a katakana name written with its own middle dot
    const name = `${String.fromCodePoint(0x30b8, 0x30e7, 0x30f3)}${String.fromCodePoint(0x30fb)}${String.fromCodePoint(0x30b9, 0x30df, 0x30b9)}`;

    // Act
    const group = tripwireCollision(row({ developerName: name }), "src/a.ts");

    // Assert
    expect(group.name).toBe(`${String.fromCodePoint(0x30b8, 0x30e7, 0x30f3)} ${String.fromCodePoint(0x30b9, 0x30df, 0x30b9)}`);
  });

  test("a bare www host keeps its letters and loses only the dot that makes it a link", () => {
    // Act
    const group = tripwireCollision(row({ developerName: "www.evil.example" }), "src/a.ts");

    // Assert
    expect(group.name).toBe("wwwevil.example");
  });
});

describe("the ordinary characters of real names, branches and files survive", () => {
  test("a hyphen in a name and a branch, an underscore inside a file name", () => {
    // Act
    const line = renderCollisionNotice(
      tripwireCollision(row({ developerName: "Jean-Luc", branch: "feat/refresh-fix_v2" }), "src/player_mapping.ts"),
      NOW,
    );

    // Assert
    expect(line).toBe(
      "crosscheck: Jean-Luc is working on player_mapping.ts on branch feat/refresh-fix_v2 (last active 1m ago) — " +
        "talk before you both change it",
    );
  });
});
