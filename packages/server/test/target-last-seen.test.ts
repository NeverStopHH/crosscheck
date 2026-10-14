/**
 * A target remembers when it was LAST touched as well as first (pilot
 * finding, 2026-10-05). A long-lived worktree session re-edits the same files
 * for weeks; `created_at` is first-seen and never bumped, so without a second
 * instant every window that asks "what was touched lately" read weeks-old
 * ages for files edited today. The re-touch is a duplicate record, answered
 * `duplicate` as before; it only moves `last_seen_at`.
 */
import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { workContextTargets } from "../src/db/schema.ts";
import {
  createHarnessWithSession,
  postRecords,
  recordEnvelope,
  TEST_START_ISO,
  validWorkContextBody,
  WORK_CONTEXT_ID,
} from "./helpers.ts";

const FILE = "src/auth/refresh.ts";
const TWO_DAYS_S = 2 * 86_400;

describe("work_context_targets.last_seen_at", () => {
  test("a first touch sets created_at only; a re-touch moves last_seen_at and nothing else", async () => {
    // Arrange
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(harness, developer, {
      records: [
        recordEnvelope("work_context", validWorkContextBody()),
        recordEnvelope("target", { workContextId: WORK_CONTEXT_ID, kind: "file", value: FILE }),
      ],
    });
    const rowOf = async () =>
      (
        await harness.db
          .select()
          .from(workContextTargets)
          .where(and(eq(workContextTargets.workContextId, WORK_CONTEXT_ID), eq(workContextTargets.value, FILE)))
      )[0];
    const first = await rowOf();

    // Act: the same file again, two days later, from the git lane.
    harness.clock.advanceSeconds(TWO_DAYS_S);
    const again = await postRecords(harness, developer, {
      records: [recordEnvelope("target", { workContextId: WORK_CONTEXT_ID, kind: "file", value: FILE, source: "git_diff" })],
    });
    const second = await rowOf();

    // Assert
    expect(first?.createdAt?.toISOString()).toBe(TEST_START_ISO);
    expect(first?.lastSeenAt).toBeNull();
    expect(again.data?.duplicates).toBe(1);
    expect(second?.createdAt?.toISOString()).toBe(TEST_START_ISO);
    expect(second?.lastSeenAt?.toISOString()).toBe(harness.clock.now().toISOString());
    // The lane upgrade the duplicate branch always did still happens.
    expect(second?.source).toBe("both");
  });
});
