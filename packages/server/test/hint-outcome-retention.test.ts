/**
 * OUTCOMES LIVE UNDER THE PILOT'S RETENTION (1.0 spec 07 §13.9, D-O6).
 *
 * An outcome is pilot measurement like a counter or an attribution, so it ages
 * out by the same rule: past PILOT_RETENTION_DAYS, on the reaper's pass, the
 * boundary day kept — every outcome figure's widest window is that same
 * number, so nothing a figure can read is removed.
 *
 * DELETE ONLY WITH PROOF (01a, the sixth principle: "data is deleted only
 * when crosscheck can prove that nothing retaining still references it").
 * The proof is machine-checked here rather than asserted: no relation in the
 * DDL references `hint_outcomes`, the registry declares no root on it, and
 * the one relation it HAS — to a delivery, and through it a session — is a
 * non-retaining edge, so deleting an outcome can strand nothing and releases
 * nothing the skeleton sweep relies on.
 */
import { describe, expect, test } from "bun:test";

import { PILOT_RETENTION_DAYS } from "../src/constants.ts";
import { hintOutcomes, noiseReassertions } from "../src/db/schema.ts";
import { RETENTION_REGISTRY } from "../src/services/retention-registry.ts";
import { reapStaleSessions } from "../src/services/sessions.ts";
import { BOOTSTRAP_SQL_URL } from "./fixtures/bootstrap-sql.ts";
import { REPO, createOutcomeWorld } from "./fixtures/hint-outcome-world.ts";

const MS_PER_DAY = 86_400_000;

describe("hint outcomes age out with the pilot (D-O6)", () => {
  test("an outcome past the window goes at the reaper's pass; the one on the boundary stays", async () => {
    // Arrange
    const world = await createOutcomeWorld();
    const now = world.harness.clock.now();
    const daysAgo = (days: number): Date => new Date(now.getTime() - days * MS_PER_DAY);
    const row = (id: string, createdAt: Date) => ({
      id,
      repo: REPO,
      deliveryId: world.delivered.kenContext,
      outcome: "followed" as const,
      reason: null,
      recordedBy: world.nick.developerId,
      // What ages out is any row past the window, whoever confirmed it.
      provenance: "unknown_legacy" as const,
      confirmationId: null,
      createdAt,
    });
    await world.harness.db
      .insert(hintOutcomes)
      .values([
        row("ho_past", daysAgo(PILOT_RETENTION_DAYS + 1)),
        row("ho_boundary", daysAgo(PILOT_RETENTION_DAYS)),
        row("ho_recent", now),
      ]);

    // Act — a pass with no session to reap
    await reapStaleSessions({ db: world.harness.db, now: () => now });

    // Assert
    const kept = await world.harness.db.select({ id: hintOutcomes.id }).from(hintOutcomes);
    expect(kept.map((outcome) => outcome.id).sort()).toEqual(["ho_boundary", "ho_recent"]);
  });

  test("the registry declares the outcomes' own lifetime, and it is the pilot's", () => {
    // Act
    const entry = RETENTION_REGISTRY.find((relation) => relation.table === "hint_outcomes");

    // Assert
    expect(entry?.semantics).toBe("non_retaining_edge");
    expect(entry?.semantics === "non_retaining_edge" ? entry.ownRetentionDays : undefined).toBe(
      PILOT_RETENTION_DAYS,
    );
  });

  test("principle 6: nothing retaining references an outcome, so deleting one strands nothing", async () => {
    // Arrange
    const ddl = await Bun.file(BOOTSTRAP_SQL_URL).text();

    // Act
    const referencing = /REFERENCES\s+hint_outcomes\b/.test(ddl);
    const rooted = RETENTION_REGISTRY.filter(
      (relation) => relation.table === "hint_outcomes" && relation.semantics === "root",
    );

    // Assert
    expect(referencing).toBe(false);
    expect(rooted).toEqual([]);
  });
});

describe("noise re-assertions age out with the outcomes they stand beside (review H-B)", () => {
  test("a re-assertion past the window goes at the reaper's pass; the one on the boundary stays", async () => {
    // Arrange
    const world = await createOutcomeWorld();
    const now = world.harness.clock.now();
    const daysAgo = (days: number): Date => new Date(now.getTime() - days * MS_PER_DAY);
    const row = (id: string, createdAt: Date) => ({
      id,
      repo: REPO,
      deliveryId: world.delivered.kenContext,
      markedBy: world.nick.developerId,
      reason: null,
      createdAt,
      provenance: "unknown_legacy" as const,
      confirmationId: null,
    });
    await world.harness.db
      .insert(noiseReassertions)
      .values([
        row("nr_past", daysAgo(PILOT_RETENTION_DAYS + 1)),
        row("nr_boundary", daysAgo(PILOT_RETENTION_DAYS)),
        row("nr_recent", now),
      ]);

    // Act
    await reapStaleSessions({ db: world.harness.db, now: () => now });

    // Assert
    const kept = await world.harness.db.select({ id: noiseReassertions.id }).from(noiseReassertions);
    expect(kept.map((reassertion) => reassertion.id).sort()).toEqual(["nr_boundary", "nr_recent"]);
  });

  test("the registry declares their lifetime, the pilot's, and nothing retaining references them", async () => {
    // Arrange
    const ddl = await Bun.file(BOOTSTRAP_SQL_URL).text();

    // Act
    const entry = RETENTION_REGISTRY.find((relation) => relation.table === "noise_reassertions");

    // Assert
    expect(entry?.semantics === "non_retaining_edge" ? entry.ownRetentionDays : undefined).toBe(
      PILOT_RETENTION_DAYS,
    );
    expect(/REFERENCES\s+noise_reassertions\b/.test(ddl)).toBe(false);
  });
});
