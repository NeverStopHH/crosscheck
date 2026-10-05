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
