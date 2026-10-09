/**
 * THE CONFIRM PAGE SHOWS NO HIDDEN CHARACTER RAW (round-1 review L4, open
 * after round 2 as N7). Agent- and teammate-written text reaches
 * "exactly what your passkey signs": a right-to-left override in a check
 * recipe reversed what the person read beside what they signed, and a line
 * break or isolate could forge context next to the real word. Every bidi
 * control and every other control or format character is shown as its code
 * point instead, so the page stays faithful to the signed bytes and none of
 * them acts. The whole injection corpus is planted in every text a draft
 * card shows.
 */
import { describe, expect, test } from "bun:test";
import type { DraftKind } from "@crosscheck/schema";

import { INJECTION_CORPUS } from "../../connector-core/test/fixtures/injection-corpus.ts";
import type { DraftContext } from "../src/services/confirm-page.ts";
import { ConfirmPage } from "../src/ui/pages/confirm.tsx";

const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCodePoint(0x2029);
const RIGHT_TO_LEFT_OVERRIDE = String.fromCodePoint(0x202e);

/** What the page must never carry raw: bidi overrides, isolates and marks, and every other control or format character. */
const HIDDEN = new RegExp(`[\\p{Cc}\\p{Cf}${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}]`, "u");

/** A draft card whose every author-written text is `text`. */
const draftOf = (kind: DraftKind, text: string): DraftContext => ({
  id: "dr_controls",
  version: 1,
  subjectKey: `${kind}:${text}`,
  kind,
  provenance: "agent_asserted",
  createdAt: "2026-10-09T00:00:00.000Z",
  repo: text,
  payload: { word: text, reason: text, deliveryId: text, check: text, files: [text, text], surface: text, name: text, pinId: text, nested: { text } },
  channel: text,
  deliveredAt: null,
  pointedTitle: text,
  sourceName: text,
  pinSurface: text,
  reconfirm: null,
});

const KINDS: readonly DraftKind[] = ["label", "outcome", "pin", "pin_broke", "pin_ok", "mute"];

/** The page's markup, outside the form fields a person edits (an input's value is its own bidi paragraph). */
const pageOf = async (text: string): Promise<string> => {
  const page = ConfirmPage({
    viewer: { name: "Nick", csrfToken: "csrf" },
    fingerprint: "fingerprint",
    drafts: KINDS.map((kind) => draftOf(kind, text)),
    hasOrigin: true,
    hasConfirmingPasskey: true,
    keyedOptOutAt: null,
  });
  return ((await Promise.resolve(page))?.toString() ?? "").replace(/<input [^>]*>/g, "<input>");
};

describe("the confirm page under the injection corpus", () => {
  test("no hidden character reaches the page raw, whatever a draft says", async () => {
    // Act
    const leaks: string[] = [];
    for (const injection of INJECTION_CORPUS) {
      if (HIDDEN.test(await pageOf(injection.payload))) {
        leaks.push(injection.id);
      }
    }

    // Assert
    expect(leaks).toEqual([]);
  });

  test("a right-to-left override in a check recipe is shown as its code point, so nothing it reverses reads as signed", async () => {
    // Act
    const page = await pageOf(`bun test${RIGHT_TO_LEFT_OVERRIDE}lmth.xedni`);

    // Assert
    expect(page).not.toContain(RIGHT_TO_LEFT_OVERRIDE);
    expect(page).toContain("bun test⟨U+202E⟩lmth.xedni");
  });
});
