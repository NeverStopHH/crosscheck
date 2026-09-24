/**
 * HOW THE EVENTUAL FIX IS NAMED (1.0 spec 07 §3.4).
 *
 * Proof 3 asks whether an attribution was right, and the only evidence that
 * can answer it is the fix: what changed between the commit a human recorded
 * broken and the commit a human re-verified. That link is LOOKED UP when
 * somebody re-pins a surface they had recorded broken — never asked, because
 * a question here would be the survey §8.3 refuses.
 *
 * THE TWO DIRECTIONS OF ERROR, and this file pins both:
 *
 *   · OVER-linking — one fix counted against two breaks, or a fix for one
 *     surface scored against another. Invisible, and it would hand proof 3
 *     a hit it never earned.
 *   · UNDER-linking — a re-pin worded differently does not link. Visible:
 *     the report prints "no repair pin yet", which is what the record says.
 *
 * The lookup is built to fail in the second direction only.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { PIN_PRESENCE_TERMINAL } from "@crosscheck/schema";

import { pins } from "../src/db/schema.ts";
import {
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = "github.com/acme/api";
const SURFACE = "Play button plays/pauses";

const setup = async (): Promise<{
  harness: TestHarness;
  developer: TestDeveloper;
}> => {
  const harness = await createTestHarness();
  const developer = await createTestDeveloper(
    harness,
    "Nick",
    "nick-repairs@example.com",
  );
  return { harness, developer };
};

const pin = async (
  harness: TestHarness,
  developer: TestDeveloper,
  id: string,
  surface: string = SURFACE,
  commit = "abc1234",
): Promise<void> => {
  const response = await harness.app.request(
    "/api/pins",
    jsonRequest("POST", developer.apiKey, {
      id,
      repo: REPO,
      surface,
      files: ["src/workbench/usePlayback.ts"],
      check: "open /workbench, press Play",
      presence: PIN_PRESENCE_TERMINAL,
      verifiedAtCommit: commit,
    }),
  );
  expect(response.status, `pin ${id}`).toBe(200);
};

const breakPin = async (
  harness: TestHarness,
  developer: TestDeveloper,
  id: string,
): Promise<void> => {
  const response = await harness.app.request(
    `/api/pins/${id}/broke`,
    jsonRequest("POST", developer.apiKey, {
      repo: REPO,
      presence: PIN_PRESENCE_TERMINAL,
    }),
  );
  expect(response.status, `break ${id}`).toBe(200);
};

const repairOf = async (
  harness: TestHarness,
  id: string,
): Promise<{ id: string | null; version: number | null }> => {
  const rows = await harness.db
    .select({
      id: pins.repairsPinId,
      version: pins.repairsPinVersion,
    })
    .from(pins)
    .where(eq(pins.id, id));
  return rows[0] ?? { id: null, version: null };
};

describe("re-pinning a surface somebody recorded broken", () => {
  test("links the new pin to the break it repairs", async () => {
    // Arrange
    const { harness, developer } = await setup();
    await pin(harness, developer, "pin_first", SURFACE, "abc1234");
    await breakPin(harness, developer, "pin_first");

    // Act — the repair: same surface, a later commit
    await pin(harness, developer, "pin_repair", SURFACE, "def5678");

    // Assert
    expect(await repairOf(harness, "pin_repair")).toEqual({
      id: "pin_first",
      version: 1,
    });
  });

  test("a surface nobody broke links nothing", async () => {
    // Arrange
    const { harness, developer } = await setup();
    await pin(harness, developer, "pin_first");

    // Act — a second, unrelated pin on the same surface
    await pin(harness, developer, "pin_second");

    // Assert
    expect(await repairOf(harness, "pin_second")).toEqual({
      id: null,
      version: null,
    });
  });

  test("one fix is never counted against the same break twice", async () => {
    // Arrange — broken, repaired. A third pin on that surface repairs
    // nothing: the break it would point at already HAS its repair.
    const { harness, developer } = await setup();
    await pin(harness, developer, "pin_first");
    await breakPin(harness, developer, "pin_first");
    await pin(harness, developer, "pin_repair");

    // Act
    await pin(harness, developer, "pin_third");

    // Assert
    expect((await repairOf(harness, "pin_third")).id).toBeNull();
  });

  test("broken, repaired, broken again — the NEXT pin repairs the second break", async () => {
    // Arrange
    const { harness, developer } = await setup();
    await pin(harness, developer, "pin_first");
    await breakPin(harness, developer, "pin_first");
    await pin(harness, developer, "pin_repair");
    await breakPin(harness, developer, "pin_repair");

    // Act
    await pin(harness, developer, "pin_second_repair");

    // Assert
    expect((await repairOf(harness, "pin_second_repair")).id).toBe(
      "pin_repair",
    );
  });

  test("a re-pin worded differently does NOT link — the visible direction", async () => {
    // Arrange — UNDER-linking prints "no repair pin yet", which is true of
    // the record. Fuzzy matching would OVER-link and score an attribution
    // against a fix for a different surface, which nobody could see.
    const { harness, developer } = await setup();
    await pin(harness, developer, "pin_first", SURFACE);
    await breakPin(harness, developer, "pin_first");

    // Act
    await pin(harness, developer, "pin_other", "The play button works");

    // Assert
    expect((await repairOf(harness, "pin_other")).id).toBeNull();
  });

  test("the repaired VERSION is the one in force at the moment of the repair", async () => {
    // Arrange — a sweep moved the watched paths before the repair, so the
    // invariant being repaired is version 2, not the one first pinned.
    const { harness, developer } = await setup();
    await pin(harness, developer, "pin_first");
    await harness.db
      .update(pins)
      .set({ version: 2 })
      .where(eq(pins.id, "pin_first"));
    await breakPin(harness, developer, "pin_first");

    // Act
    await pin(harness, developer, "pin_repair");

    // Assert
    expect((await repairOf(harness, "pin_repair")).version).toBe(2);
  });
});

describe("recording where a break was observed (07 §3.4, corrected)", () => {
  const breakWith = async (
    harness: TestHarness,
    developer: TestDeveloper,
    id: string,
    brokeAtCommit: string,
  ): Promise<Response> =>
    harness.app.request(
      `/api/pins/${id}/broke`,
      jsonRequest("POST", developer.apiKey, {
        repo: REPO,
        presence: PIN_PRESENCE_TERMINAL,
        brokeAtCommit,
      }),
    );

  const brokeAtCommitOf = async (harness: TestHarness, id: string) =>
    (
      await harness.db
        .select({ commit: pins.brokeAtCommit })
        .from(pins)
        .where(eq(pins.id, id))
    )[0]?.commit ?? null;

  test("the commit a break was recorded at is stored — proof 3's range starts there", async () => {
    // Arrange
    const { harness, developer } = await setup();
    await pin(harness, developer, "pin_a");

    // Act
    const response = await breakWith(harness, developer, "pin_a", "b0b0b0b");

    // Assert
    expect(response.status).toBe(200);
    expect(await brokeAtCommitOf(harness, "pin_a")).toBe("b0b0b0b");
  });

  test("the no-commit placeholder is stored as no commit, never as a range start", async () => {
    // Arrange
    const { harness, developer } = await setup();
    await pin(harness, developer, "pin_a");

    // Act
    await breakWith(harness, developer, "pin_a", "0000000");

    // Assert
    expect(await brokeAtCommitOf(harness, "pin_a")).toBeNull();
  });

  test("a value that is not a commit id is refused — it reaches every reader's git", async () => {
    // Arrange
    const { harness, developer } = await setup();
    await pin(harness, developer, "pin_a");

    // Act
    const response = await breakWith(harness, developer, "pin_a", "--output=x");

    // Assert
    expect(response.status).toBe(400);
    expect(await brokeAtCommitOf(harness, "pin_a")).toBeNull();
  });
});

