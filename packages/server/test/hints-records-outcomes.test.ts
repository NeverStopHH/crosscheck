/**
 * The prompt-time candidates answer says whether this repo records what a
 * hint led to (1.0 spec 07 §13).
 *
 * The connector appends its one outcome clause only when this says yes. A
 * clause on a repo nobody enrolled would invite a call the hub refuses — an
 * unasked sentence that can only fail — so the fact rides the one call the
 * prompt already makes, never a second request inside the 800 ms budget.
 */
import { describe, expect, test } from "bun:test";

import { REPO, createOutcomeWorld } from "./fixtures/hint-outcome-world.ts";
import { jsonRequest } from "./helpers.ts";

const candidates = async (enrolled: boolean): Promise<Record<string, unknown>> => {
  const world = await createOutcomeWorld({ enrolled });
  const response = await world.harness.app.request(
    `/api/hints/candidates?query=${encodeURIComponent("filter row widen")}&repo=${encodeURIComponent(REPO)}`,
    jsonRequest("GET", world.nick.apiKey),
  );
  return ((await response.json()) as { data: Record<string, unknown> }).data;
};

describe("GET /api/hints/candidates — recordsOutcomes", () => {
  test("an enrolled repo says it records outcomes", async () => {
    // Act
    const data = await candidates(true);

    // Assert
    expect(data["recordsOutcomes"]).toBe(true);
  });

  test("a repo nobody enrolled says it does not", async () => {
    // Act
    const data = await candidates(false);

    // Assert
    expect(data["recordsOutcomes"]).toBe(false);
  });
});

/** The answer one GET gives, on an enrolled or an unenrolled world. */
const answerOf = async (enrolled: boolean, path: string): Promise<Record<string, unknown>> => {
  const world = await createOutcomeWorld({ enrolled });
  const response = await world.harness.app.request(path, jsonRequest("GET", world.nick.apiKey));
  return ((await response.json()) as { data: Record<string, unknown> }).data;
};

const TRIPWIRE = `/api/hints/tripwire?repo=${encodeURIComponent(REPO)}&value=${encodeURIComponent("src/filters.ts")}`;
const SOLVED = `/api/solved-matches?repo=${encodeURIComponent(REPO)}`;

describe("the tripwire and the briefing's solved pointers say it too (07 §13, D-O3)", () => {
  test("the tripwire answer carries recordsOutcomes on the call PreToolUse already makes", async () => {
    // Act
    const enrolled = await answerOf(true, TRIPWIRE);
    const unenrolled = await answerOf(false, TRIPWIRE);

    // Assert
    expect(enrolled["recordsOutcomes"]).toBe(true);
    expect(unenrolled["recordsOutcomes"]).toBe(false);
  });

  test("the solved-match listing carries it on the call SessionStart already makes", async () => {
    // Act
    const enrolled = await answerOf(true, SOLVED);
    const unenrolled = await answerOf(false, SOLVED);

    // Assert
    expect(enrolled["recordsOutcomes"]).toBe(true);
    expect(unenrolled["recordsOutcomes"]).toBe(false);
  });
});
