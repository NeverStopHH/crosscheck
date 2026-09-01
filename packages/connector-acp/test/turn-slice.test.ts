/**
 * THE TURN SLICE'S OWN UNIT PINS — the bounded structure the Tier-1 rung
 * stands on, tested away from the engine because its two failure modes are
 * both quiet ones: it can grow without bound, or it can throw away a session's
 * evidence with nothing counted.
 */
import { describe, expect, test } from "bun:test";

import {
  ACP_MAX_SLICE_SESSIONS,
  ACP_TURN_SLICE_MAX_CHARS,
} from "../src/constants.ts";
import { createTurnSliceStore } from "../src/derive/slice.ts";

describe("the slice is bounded, and the bound DROPS rather than grows", () => {
  test("past the cap it keeps what it has and counts what it refused", () => {
    // Arrange
    const slice = createTurnSliceStore().for("s1");
    const half = "a".repeat(Math.ceil(ACP_TURN_SLICE_MAX_CHARS / 2));

    // Act — three halves against a two-half budget
    slice.add(half);
    slice.add(half);
    slice.add(half);

    // Assert
    expect(slice.text().length).toBeLessThanOrEqual(ACP_TURN_SLICE_MAX_CHARS);
    expect(slice.dropped()).toBeGreaterThan(0);
  });

  test("an overflowing piece keeps its HEAD — a partial source is still evidence", () => {
    // Arrange
    const slice = createTurnSliceStore().for("s1");

    // Act
    slice.add("x".repeat(ACP_TURN_SLICE_MAX_CHARS - 5));
    slice.add("HEADKEPT-and-then-a-lot-more");

    // Assert — 5 chars of room, one spent on the join separator, so 4 land
    expect(slice.text()).toContain("HEAD");
    expect(slice.text().length).toBe(ACP_TURN_SLICE_MAX_CHARS);
    expect(slice.dropped()).toBe("HEADKEPT-and-then-a-lot-more".length - 4);
  });

  test("a one-character-per-chunk agent cannot double the slice", () => {
    // THE BUG THIS PINS, measured before the fix: `text()` joins the parts
    // with a newline and the budget counted only the pieces, so an agent
    // streaming one character per message chunk filled 47,999 characters
    // against a 24,000 cap — the separators doubling it exactly. The cap has
    // to be a cap on the string the gate and the worker actually receive.
    // Arrange
    const slice = createTurnSliceStore().for("s1");

    // Act — far more chunks than the cap can hold, in the worst shape
    for (let index = 0; index < ACP_TURN_SLICE_MAX_CHARS * 2; index += 1) {
      slice.add("x");
    }

    // Assert
    expect(slice.text().length).toBeLessThanOrEqual(ACP_TURN_SLICE_MAX_CHARS);
    expect(slice.dropped()).toBeGreaterThan(0);
  });
});

describe("one accumulator per session, bounded FIFO", () => {
  test("a new session past the cap evicts the oldest, never memory", () => {
    // Arrange
    const store = createTurnSliceStore();
    for (let index = 0; index < ACP_MAX_SLICE_SESSIONS; index += 1) {
      store.for(`s${String(index)}`).add(`text-${String(index)}`);
    }

    // Act — one session too many
    store.for("newcomer").add("newcomer text");

    // Assert
    expect(store.for("s0").text()).toBe("");
    expect(store.for("newcomer").text()).toBe("newcomer text");
  });

  test("a TURN BOUNDARY on a known session evicts nobody", () => {
    // THE BUG THIS PINS: reset() evicted unconditionally, so once the map was
    // full every prompt on any session silently threw away the OLDEST other
    // session's accumulated turn — capture accuracy lost, nothing counted.
    // Replacing a key the map already holds changes its size by zero and must
    // therefore evict nothing.
    // Arrange
    const store = createTurnSliceStore();
    for (let index = 0; index < ACP_MAX_SLICE_SESSIONS; index += 1) {
      store.for(`s${String(index)}`).add(`text-${String(index)}`);
    }

    // Act — the newest session starts a new turn
    store.reset(`s${String(ACP_MAX_SLICE_SESSIONS - 1)}`);

    // Assert — the neighbour is untouched, and the reset session is empty
    expect(store.for("s0").text()).toBe("text-0");
    expect(store.for(`s${String(ACP_MAX_SLICE_SESSIONS - 1)}`).text()).toBe("");
  });

  test("forgetting a session drops its accumulator outright", () => {
    // Arrange
    const store = createTurnSliceStore();
    store.for("s1").add("something");

    // Act
    store.forget("s1");

    // Assert
    expect(store.for("s1").text()).toBe("");
  });
});
