/**
 * THE ANCHORING ASYMMETRY, ENFORCED (DESIGN.md §4).
 *
 * A claim body may be long — Nick asked for ten thousand characters so that a
 * genuinely detailed root cause survives a deliberate read intact. What must
 * NOT happen is that length following the body onto a surface nobody asked
 * for: a SessionStart briefing, a mid-prompt hint, a statusline, a report
 * written for later. One maximum-length finding in a briefing eats the whole
 * budget and pushes every other teammate out of it, which is the opposite of
 * what the reader opened the session for.
 *
 * WHY THIS FILE IS THE DELIVERABLE RATHER THAN THE CONSTANT. The separation is
 * one `quotedBody` argument on each of a dozen surfaces, and the failure mode
 * is not somebody arguing for a change — it is somebody reaching for
 * MAX_CLAIM_BODY_LENGTH because it is the cap that is in scope, and inheriting
 * a raise nobody weighed. That is not hypothetical: hints/render.ts passed the
 * schema constant on BOTH hint surfaces until the raise, so the tightness of
 * every hint in this product was an accident of the wire cap being small.
 *
 * HOW IT IS ENFORCED — REGISTRY-DRIVEN, NOT A HAND-KEPT LIST. Every surface
 * declares `delivery` (src/render-surfaces.ts), the walk covers every package
 * (fixtures/registry-packages.ts), and the assertions below run on whatever
 * that walk returns. A new unsolicited surface is covered the day it is
 * registered, and it cannot be registered without classifying itself: the
 * field is required, so skipping it is a type error. A list of "the tight
 * surfaces" maintained here would be a copy of the registry, and the copy is
 * exactly where a leak would hide.
 *
 * THE TWO ASSERTIONS, and why the first one is the load-bearing one:
 *
 *   1. IDENTITY ACROSS LENGTH. A surface's output for a 10,000-character
 *      payload is BYTE-IDENTICAL to its output for a 500-character one. Both
 *      exceed every unsolicited slot cap, so a surface that cuts at its own
 *      cap cannot tell them apart — and one that inherited the wire cap
 *      renders 9,500 characters more. It catches the SILENT DEATH too, which
 *      a leak-only assertion would miss: with the cap inherited, a hint's
 *      fitter drops its only substance line entirely and the hint arrives
 *      headed and empty. That is a worse failure than a leak and it makes a
 *      surface FASTER, so nothing else in the suite would call it a
 *      regression.
 *
 *   2. NO FAR BYTES. The payload carries a position-indexed sentinel every
 *      SENTINEL_STRIDE characters, and no sentinel from beyond
 *      UNSOLICITED_CLAIM_BODY_MAX_CHARS may appear in the output. Assertion 1
 *      already implies it; this one names the bytes, so a failure reads as
 *      "the marker from offset 4,500 reached the briefing" rather than as a
 *      diff of two large strings.
 *
 * AND THE OTHER DIRECTION, which keeps the file from passing vacuously if the
 * raise were reverted: a PULLED surface must show text from beyond the tight
 * cap. Without it, pinning every surface to 400 would make this file green
 * while deleting the feature it exists to protect.
 */
import { describe, expect, test } from "bun:test";

import { MAX_CLAIM_BODY_LENGTH } from "@crosscheck/schema";

import { UNSOLICITED_CLAIM_BODY_MAX_CHARS } from "../src/constants.ts";
import type {
  CorpusRenderSurface,
  RenderSurface,
} from "../src/render-surfaces.ts";
import { ALL_REGISTERED_SURFACES } from "./fixtures/registry-packages.ts";

/**
 * Distance between sentinels. Smaller than the tight cap, so at least one
 * sentinel lands inside what a surface legitimately shows and the corpus is
 * not merely proving that nothing rendered at all.
 */
const SENTINEL_STRIDE = 250;

/** Nick's cap: the length a pulled surface must carry intact. */
const LONG_CHARS = 10_000;

/**
 * The control length.
 *
 * ABOVE every unsolicited slot cap (the widest is a question body at 400) and
 * BELOW MAX_HINT_TEXT_LENGTH, which is what makes the identity assertion sharp
 * in both directions: a correctly pinned surface cuts both payloads at its own
 * cap and cannot tell them apart, while a surface that inherited the wire cap
 * renders the control in full and the long one either in full or not at all.
 */
const CONTROL_CHARS = 500;

/**
 * A sentinel that survives the sanitizer: lowercase letters and digits only,
 * no injection phrase, nothing NFKC folds and nothing `bare` strips.
 */
const sentinel = (offset: number): string =>
  `zqx${String(offset).padStart(5, "0")}qzx`;

/**
 * Ordinary prose carrying a position-indexed marker every SENTINEL_STRIDE
 * characters, so any byte in the output can be traced back to its offset.
 */
const sentinelPayload = (chars: number): string => {
  const filler =
    " the refresh path never reloads the rotated key after a rotation lands ";
  let text = "";
  while (text.length < chars) {
    const offset = Math.floor(text.length / SENTINEL_STRIDE) * SENTINEL_STRIDE;
    text += `${sentinel(offset)}${filler}`;
  }
  return text.slice(0, chars);
};

const LONG_PAYLOAD = sentinelPayload(LONG_CHARS);
const CONTROL_PAYLOAD = sentinelPayload(CONTROL_CHARS);

/** Sentinels whose offset is at or beyond the tight cap — the forbidden set. */
const FAR_OFFSETS: readonly number[] = Array.from(
  { length: Math.floor(LONG_CHARS / SENTINEL_STRIDE) },
  (_unused, index) => index * SENTINEL_STRIDE,
).filter((offset) => offset >= UNSOLICITED_CLAIM_BODY_MAX_CHARS);

const FAR_SENTINELS: readonly string[] = FAR_OFFSETS.map(sentinel);

/**
 * One sentinel from deep inside the long body, used to prove the PULLED half.
 *
 * TAKEN FROM `FAR_OFFSETS` RATHER THAN COMPUTED, because a marker only exists
 * at a multiple of SENTINEL_STRIDE: an arithmetic offset like "twice the tight
 * cap" is 800, no sentinel is planted there, and the assertion would have
 * looked for a string the payload never contained — passing or failing for a
 * reason that had nothing to do with the caps.
 */
const DEEP_SENTINEL = sentinel(FAR_OFFSETS[FAR_OFFSETS.length - 1] ?? 0);

const isCorpus = (surface: RenderSurface): surface is CorpusRenderSurface =>
  surface.kind === "corpus";

/**
 * OUTBOUND IS HELD TO THE UNSOLICITED RULE. A ghost draft body and a work
 * context title are not shown to the reader who produced them — they are
 * stored, and what stores them will one day PUSH them at somebody. A long
 * body written out here is a long body injected later.
 */
const TIGHT_SURFACES: readonly CorpusRenderSurface[] =
  ALL_REGISTERED_SURFACES.filter(isCorpus).filter(
    (surface) =>
      surface.delivery === "unsolicited" || surface.delivery === "outbound",
  );

const PULLED_SURFACES: readonly CorpusRenderSurface[] =
  ALL_REGISTERED_SURFACES.filter(isCorpus).filter(
    (surface) => surface.delivery === "pulled",
  );

describe("a long claim body never reaches a surface nobody asked for", () => {
  test("there are tight surfaces to check — the walk cannot come back empty", () => {
    // Arrange/Act: the registries, as discovered.
    // Assert: a floor, so a broken walk or an emptied registry fails LOUDLY
    // rather than passing this file with nothing to say. Core's hints,
    // briefings, conference and tripwire, plus the cursor and ACP injections.
    expect(TIGHT_SURFACES.length).toBeGreaterThanOrEqual(15);
    expect(PULLED_SURFACES.length).toBeGreaterThanOrEqual(1);
  });

  test("the payload is built so a leak has somewhere to show", () => {
    // Arrange/Act/Assert: the fixture's own preconditions, stated rather than
    // assumed — a payload with no far sentinels would make every assertion
    // below vacuous, and a control that fits under a cap would make the
    // identity check compare two uncut strings.
    expect(LONG_PAYLOAD.length).toBe(LONG_CHARS);
    expect(CONTROL_PAYLOAD.length).toBe(CONTROL_CHARS);
    expect(CONTROL_CHARS).toBeGreaterThan(UNSOLICITED_CLAIM_BODY_MAX_CHARS);
    expect(FAR_SENTINELS.length).toBeGreaterThan(30);
    expect(LONG_PAYLOAD).toContain(sentinel(0));
    expect(LONG_PAYLOAD).toContain(DEEP_SENTINEL);
    for (const far of FAR_SENTINELS) {
      expect(LONG_PAYLOAD).toContain(far);
    }
  });

  test.each(TIGHT_SURFACES.map((surface) => [surface.name, surface] as const))(
    "%s renders a 10,000-char body exactly as it renders a 500-char one",
    (_name, surface) => {
      // Arrange: two payloads sharing a prefix, both past every cap this
      // surface applies.
      // Act
      const long = surface.render(LONG_PAYLOAD);
      const control = surface.render(CONTROL_PAYLOAD);

      // Assert: past its own cap, more body changes NOTHING here — not the
      // text, not the length, and not how many lines the surface manages to
      // say (a dropped substance line would show up as a shorter output).
      expect(long, surface.name).toBe(control);
    },
  );

  test.each(TIGHT_SURFACES.map((surface) => [surface.name, surface] as const))(
    "%s emits no byte from beyond the tight cap",
    (_name, surface) => {
      // Act
      const output = surface.render(LONG_PAYLOAD);

      // Assert
      for (const far of FAR_SENTINELS) {
        expect(output.includes(far), `${surface.name} leaked ${far}`).toBe(
          false,
        );
      }
    },
  );

  test("a PULLED surface does carry the long body — the raise is real", () => {
    // Arrange: the other direction. Pinning every surface to the tight cap
    // would satisfy every assertion above while deleting the feature they
    // exist to protect, so at least one pulled surface must show text the
    // unsolicited ones are forbidden to show.
    const carriers = PULLED_SURFACES.filter((surface) =>
      surface.render(LONG_PAYLOAD).includes(DEEP_SENTINEL),
    );

    // Assert
    expect(
      carriers.length,
      `no pulled surface carried ${DEEP_SENTINEL}, the marker from the end of a ${String(LONG_CHARS)}-char body`,
    ).toBeGreaterThanOrEqual(1);
    expect(MAX_CLAIM_BODY_LENGTH).toBeGreaterThan(
      UNSOLICITED_CLAIM_BODY_MAX_CHARS,
    );
  });
});
