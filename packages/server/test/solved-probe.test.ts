/**
 * `listSolvedByFingerprint` — the FAILURE-TIME probe, which is the block's
 * headline delivery moment and had no positive server-side test at all: the
 * only route coverage of `?fingerprint=` was the over-long-value refusal in
 * solved-counts.test.ts, and the connector's fixture hub answers the route
 * regardless of the parameter, so it cannot stand in for this.
 *
 * What is pinned here is what the probe PROMISES its caller, because the
 * connector prints a sentence asserting each one: the row carries THIS
 * fingerprint (content identity, the claim in the hint's header), the tree
 * is solved (the vouch behind the quoted root cause), and every row says so
 * in `matchedTargetKind` (the second check the renderer applies).
 *
 * And the crowd case, which is how the listing's own fan-out defect
 * reappeared one path over: the candidate window has to be filled with rows
 * that could be ANSWERS rather than with traffic carrying the same value.
 */
import { describe, expect, test } from "bun:test";

import {
  SOLVED_MATCH_MAX_PROBE_ROWS,
} from "../src/constants.ts";
import {
  agentSessions,
  claims,
  workContextTargets,
  workContexts,
} from "../src/db/schema.ts";
import { listSolvedByFingerprint } from "../src/services/solved-matches.ts";
import { createTestDeveloper, createTestHarness } from "./helpers.ts";

const REPO = "github.com/acme/api";
const FINGERPRINT = "sha256:1111222233334444555566667777888899990000";
const OTHER_FINGERPRINT = "sha256:aaaabbbbccccddddeeeeffff0000111122223333";
const ROOT_CAUSE = "the rotation drops the key id before the importer retries";

const NOW = new Date("2026-08-26T09:00:00.000Z");
const daysAgo = (days: number): Date =>
  new Date(NOW.getTime() - days * 24 * 3600 * 1000);

const session = (id: string, repo = REPO, developerId = "") => ({
  id,
  developerId,
  agentKind: "claude-code",
  repo,
  branch: "fix/rotation",
  baseCommit: "a1b2c3d4",
  status: "analyzing" as const,
  startedAt: daysAgo(200),
  lastHeartbeatAt: daysAgo(200),
});

const context = (id: string, sessionId: string, ageDays: number) => ({
  id,
  sessionId,
  title: `Refresh 500s after key rotation ${id}`,
  status: "analyzing" as const,
  normalizedDoc: "refresh 500s after key rotation",
  createdAt: daysAgo(ageDays),
  updatedAt: daysAgo(ageDays),
});

const solvingClaim = (contextId: string, sessionId: string) => ({
  id: `clm_${contextId}`,
  workContextId: contextId,
  authorSessionId: sessionId,
  kind: "observation" as const,
  status: "likely_root_cause" as const,
  body: ROOT_CAUSE,
  confidence: 0.9,
  captureMode: "agent" as const,
  provenance: "declared" as const,
  evidenceRefs: ["clm_evidence_row"],
  createdAt: daysAgo(199),
});

const fingerprintTarget = (workContextId: string, value = FINGERPRINT) => ({
  workContextId,
  kind: "error_fingerprint" as const,
  value,
});

describe("the failure-time fingerprint probe", () => {
  test("answers with the solved tree carrying THIS fingerprint", async () => {
    // Arrange: one solved tree on the asked-for fingerprint, one solved tree
    // on a different one — the second is the control that makes the equality
    // in the first assertion mean something.
    const harness = await createTestHarness();
    const developer = await createTestDeveloper(harness, "Ken", "ken@acme.dev");
    await harness.db
      .insert(agentSessions)
      .values([session("ses_a", REPO, developer.developerId)]);
    await harness.db
      .insert(workContexts)
      .values([context("wc_here", "ses_a", 200), context("wc_other", "ses_a", 200)]);
    await harness.db
      .insert(claims)
      .values([solvingClaim("wc_here", "ses_a"), solvingClaim("wc_other", "ses_a")]);
    await harness.db
      .insert(workContextTargets)
      .values([
        fingerprintTarget("wc_here"),
        fingerprintTarget("wc_other", OTHER_FINGERPRINT),
      ]);
    const deps = { db: harness.db, now: () => NOW };

    // Act
    const rows = await listSolvedByFingerprint(
      deps,
      developer.developerId,
      FINGERPRINT,
    );

    // Assert: the right tree, the kind the connector's header asserts, and
    // the recorded cause the fingerprint tier is allowed to carry.
    expect(rows.map((row) => row.workContextId)).toEqual(["wc_here"]);
    expect(rows[0]?.matchedTargetKind).toBe("error_fingerprint");
    expect(rows[0]?.rootCause).toBe(ROOT_CAUSE);
  });

  test("a tree carrying the fingerprint but nothing solved is not an answer", async () => {
    // Arrange: identical to the case above minus the solving claim.
    const harness = await createTestHarness();
    const developer = await createTestDeveloper(harness, "Ken", "ken@acme.dev");
    await harness.db
      .insert(agentSessions)
      .values([session("ses_a", REPO, developer.developerId)]);
    await harness.db.insert(workContexts).values([context("wc_here", "ses_a", 200)]);
    await harness.db.insert(workContextTargets).values([fingerprintTarget("wc_here")]);
    const deps = { db: harness.db, now: () => NOW };

    // Act & Assert
    expect(
      await listSolvedByFingerprint(deps, developer.developerId, FINGERPRINT),
    ).toEqual([]);

    // …and the CONTROL: the same row, once somebody records the cause.
    await harness.db.insert(claims).values([solvingClaim("wc_here", "ses_a")]);
    expect(
      (
        await listSolvedByFingerprint(deps, developer.developerId, FINGERPRINT)
      ).map((row) => row.workContextId),
    ).toEqual(["wc_here"]);
  });

  test(
    "a crowd sharing the fingerprint does not hide the answer",
    async () => {
      // Arrange: one solved tree plus a crowd of UNSOLVED contexts carrying
      // the same hot fingerprint — the shape a common failure produces on any
      // real hub, and now the ordinary one, since PostToolUseFailure captures
      // a fingerprint on every tool failure. The crowd's ids sort ahead of
      // the answer's, which is all it took.
      const harness = await createTestHarness();
      const developer = await createTestDeveloper(harness, "Ken", "ken@acme.dev");
      await harness.db
        .insert(agentSessions)
        .values([session("ses_a", REPO, developer.developerId)]);
      const crowd = Array.from(
        { length: SOLVED_MATCH_MAX_PROBE_ROWS },
        (_, index) =>
          context(`wc_crowd_${String(index).padStart(4, "0")}`, "ses_a", 1),
      );
      await harness.db
        .insert(workContexts)
        .values([context("wc_solved", "ses_a", 200), ...crowd]);
      await harness.db.insert(claims).values([solvingClaim("wc_solved", "ses_a")]);
      await harness.db
        .insert(workContextTargets)
        .values([
          fingerprintTarget("wc_solved"),
          ...crowd.map((row) => fingerprintTarget(row.id)),
        ]);
      const deps = { db: harness.db, now: () => NOW };

      // Act
      const rows = await listSolvedByFingerprint(
        deps,
        developer.developerId,
        FINGERPRINT,
      );

      // Assert: the crowd is traffic, not answers, so it never enters the
      // window. It fails to SILENCE when it does — nothing is shown, so
      // nothing is counted, and every instrument stays green.
      expect(rows.map((row) => row.workContextId)).toEqual(["wc_solved"]);
    },
    30_000,
  );
});
