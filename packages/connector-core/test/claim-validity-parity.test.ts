/**
 * The connector's substance gate and the hub's solved-floor rule must decide
 * alike: a tree the hub's search lifts as a settled answer is a tree the hint
 * lanes would assert, and the other way round. The two live in two packages
 * because the hub cannot import the connector, so this test is what keeps
 * them one definition — every validity state against every commit binding.
 */
import { describe, expect, test } from "bun:test";
import { CLAIM_COMMIT_BINDINGS, CLAIM_VALIDITY_STATES } from "@crosscheck/schema";
import type { ClaimValidity } from "@crosscheck/schema";
import { isAssertableCause } from "@crosscheck/server";

import { isAssertableValidity } from "../src/claim-validity.ts";

const validity = (
  state: ClaimValidity["state"],
  commitBinding: ClaimValidity["commitBinding"],
): ClaimValidity => ({
  state,
  commitBinding,
  observedAtCommit: commitBinding === "none" ? null : "a1b2c3d",
  basis: null,
  refCommit: null,
  selfReported: false,
  touchingCommits: [],
  touchingTotal: null,
  lastRevalidatedAt: null,
  supersededByClaimId: state === "superseded" ? "clm_newer" : null,
});

describe("the hub's solved floor and the connector's substance gate", () => {
  test("decide alike for every validity state and every commit binding", () => {
    // Arrange
    const cases = CLAIM_VALIDITY_STATES.flatMap((state) =>
      CLAIM_COMMIT_BINDINGS.map((binding) => validity(state, binding)),
    );

    // Act
    const disagreements = cases.filter(
      (entry) => isAssertableCause(entry) !== isAssertableValidity(entry),
    );

    // Assert
    expect(cases.length).toBe(CLAIM_VALIDITY_STATES.length * CLAIM_COMMIT_BINDINGS.length);
    expect(disagreements.map((entry) => `${entry.state}/${entry.commitBinding}`)).toEqual([]);
  });

  test("refuse every cause with no commit binding and every cause measured against", () => {
    // Arrange
    const refused = [
      validity("current", "none"),
      validity("unknown", "none"),
      validity("stale", "session_base"),
      validity("invalidated", "reported"),
      validity("superseded", "session_base"),
    ];
    const allowed = [validity("current", "session_base"), validity("unknown", "reported")];

    // Act and Assert
    expect(refused.map(isAssertableCause)).toEqual([false, false, false, false, false]);
    expect(allowed.map(isAssertableCause)).toEqual([true, true]);
  });
});
