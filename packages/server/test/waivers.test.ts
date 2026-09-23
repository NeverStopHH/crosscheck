/**
 * IS THIS FENCE OPEN (1.0 spec 04 §3.6) — and every way of not being.
 *
 * A live waiver is the only thing that turns a `PROTECTED_CONFLICT` into
 * `protected_ok`, so every way of NOT being live has to actually close the
 * fence. The dangerous direction is uniform: each bug here leaves a fence open
 * that a human closed, or never opened.
 *
 * ROWS ARE WRITTEN DIRECTLY, because the three `/api/fence-waivers` routes are
 * the next slice and this is the read all three will rest on. The shape CHECK
 * in bootstrap.sql is what keeps a hand-written row honest — a grant without an
 * expiry does not insert at all, which is AT-6 discharged as a database
 * impossibility, and `ddl-sync.test.ts` holds the two authorities together.
 */
import { describe, expect, test } from "bun:test";

import { fenceWaivers, pins } from "../src/db/schema.ts";
import { readLiveWaiver } from "../src/services/waivers.ts";
import { createTestDeveloper, createTestHarness } from "./helpers.ts";
import type { TestHarness } from "./helpers.ts";

const REPO = "github.com/acme/api";
const NOW = new Date("2026-09-23T12:00:00.000Z");
const PIN = "pin_fence";

const HOUR = 3_600_000;
const hourBefore = new Date(NOW.getTime() - HOUR);
const hourAfter = new Date(NOW.getTime() + HOUR);

/** A pin to hang waivers off — the foreign key insists on one. */
const seedPin = async (
  harness: TestHarness,
  developerId: string,
): Promise<void> => {
  await harness.db.insert(pins).values({
    id: PIN,
    repo: REPO,
    surface: "the refresh path keeps working",
    verifiedBy: developerId,
    verifiedAtCommit: "a1b2c3d",
    verifiedAt: hourBefore,
    checkRecipe: "bun test packages/server/test/auth.test.ts",
    captureMode: "human",
    createdAt: hourBefore,
  });
};

interface WaiverRow {
  readonly id: string;
  readonly kind: "grant" | "revoke";
  readonly expiresAt: Date | null;
  readonly supersedes: string | null;
  readonly createdAt: Date;
  readonly pinVersion?: number;
}

const seedWaiver = async (
  harness: TestHarness,
  developerId: string,
  row: WaiverRow,
): Promise<void> => {
  await harness.db.insert(fenceWaivers).values({
    id: row.id,
    repo: REPO,
    pinId: PIN,
    pinVersion: row.pinVersion ?? 1,
    kind: row.kind,
    grantedBy: developerId,
    captureMode: "human",
    reason: "Rollout is blocked; the fix lands Monday",
    expiresAt: row.expiresAt,
    supersedes: row.supersedes,
    createdAt: row.createdAt,
  });
};

const live = async (harness: TestHarness, pinVersion = 1) =>
  readLiveWaiver({
    db: harness.db,
    repo: REPO,
    pinId: PIN,
    pinVersion,
    now: NOW,
  });

const setup = async (): Promise<{
  harness: TestHarness;
  developerId: string;
}> => {
  const harness = await createTestHarness();
  const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
  await seedPin(harness, nick.developerId);
  return { harness, developerId: nick.developerId };
};

describe("readLiveWaiver", () => {
  test("no grant at all leaves the fence closed", async () => {
    // Arrange — the state of every pin nobody has waived. The default must be
    // closed: an open fence is a permission, and permissions are not defaults.
    const { harness } = await setup();

    // Assert
    expect(await live(harness)).toBeNull();
  });

  test("a grant that has not expired is live", async () => {
    // Arrange
    const { harness, developerId } = await setup();
    await seedWaiver(harness, developerId, {
      id: "fw_grant",
      kind: "grant",
      expiresAt: hourAfter,
      supersedes: null,
      createdAt: hourBefore,
    });

    // Assert
    expect((await live(harness))?.id).toBe("fw_grant");
  });

  test("an EXPIRED grant closes the fence again, with nobody acting", async () => {
    // Arrange — the point of a bounded waiver: it lapses on its own. Expiry is
    // a comparison rather than a swept state, so a hub that was offline for a
    // week does not leave fences open behind it.
    const { harness, developerId } = await setup();
    await seedWaiver(harness, developerId, {
      id: "fw_expired",
      kind: "grant",
      expiresAt: hourBefore,
      supersedes: null,
      createdAt: new Date(NOW.getTime() - 2 * HOUR),
    });

    // Assert
    expect(await live(harness)).toBeNull();
  });

  test("a REVOKE closes a grant that would otherwise still be live", async () => {
    // Arrange — append-only: the revoke is a second row naming the first, not
    // an edit. The grant row survives, which is what lets a team see that the
    // fence WAS open for those two hours.
    const { harness, developerId } = await setup();
    await seedWaiver(harness, developerId, {
      id: "fw_grant",
      kind: "grant",
      expiresAt: hourAfter,
      supersedes: null,
      createdAt: new Date(NOW.getTime() - 2 * HOUR),
    });
    await seedWaiver(harness, developerId, {
      id: "fw_revoke",
      kind: "revoke",
      expiresAt: null,
      supersedes: "fw_grant",
      createdAt: hourBefore,
    });

    // Assert
    expect(await live(harness)).toBeNull();
  });

  test("a RE-GRANT after a revoke opens it again — the case order gets wrong", async () => {
    // Arrange — grant, revoke, grant. Read as "find a grant, then check whether
    // it was ever revoked" this answers CLOSED, which is wrong in the direction
    // that confuses a team: they opened the fence and the product says they did
    // not. Newest decision first is what gets it right.
    const { harness, developerId } = await setup();
    await seedWaiver(harness, developerId, {
      id: "fw_first",
      kind: "grant",
      expiresAt: hourAfter,
      supersedes: null,
      createdAt: new Date(NOW.getTime() - 3 * HOUR),
    });
    await seedWaiver(harness, developerId, {
      id: "fw_revoke",
      kind: "revoke",
      expiresAt: null,
      supersedes: "fw_first",
      createdAt: new Date(NOW.getTime() - 2 * HOUR),
    });
    await seedWaiver(harness, developerId, {
      id: "fw_second",
      kind: "grant",
      expiresAt: hourAfter,
      supersedes: null,
      createdAt: hourBefore,
    });

    // Assert
    expect((await live(harness))?.id).toBe("fw_second");
  });

  test("a waiver does NOT travel to the next version of the invariant", async () => {
    // Arrange — the whole reason `pins.version` exists. A sweep moved the
    // watched paths, so this is a different invariant, and consent does not
    // cross that boundary. Without it a rename silently widens what a human
    // agreed to.
    const { harness, developerId } = await setup();
    await seedWaiver(harness, developerId, {
      id: "fw_v1",
      kind: "grant",
      expiresAt: hourAfter,
      supersedes: null,
      createdAt: hourBefore,
      pinVersion: 1,
    });

    // Assert
    expect((await live(harness, 1))?.id).toBe("fw_v1");
    expect(await live(harness, 2)).toBeNull();
  });

  test("the database refuses a grant with no expiry — AT-6, as an impossibility", async () => {
    // Arrange — the shape CHECK, not a service rule. A grant that never expires
    // is a permanent permission nobody agreed to, and the way to make that
    // unavailable is to make the row unwritable.
    const { harness, developerId } = await setup();

    // Act
    const write = seedWaiver(harness, developerId, {
      id: "fw_forever",
      kind: "grant",
      expiresAt: null,
      supersedes: null,
      createdAt: hourBefore,
    });

    // Assert
    await expect(write).rejects.toThrow();
  });

  test("the database refuses a revoke that supersedes nothing", async () => {
    // Arrange — the other half of the shape. A revoke naming no grant is a
    // closure with no account of what it closed.
    const { harness, developerId } = await setup();

    // Act
    const write = seedWaiver(harness, developerId, {
      id: "fw_orphan",
      kind: "revoke",
      expiresAt: null,
      supersedes: null,
      createdAt: hourBefore,
    });

    // Assert
    await expect(write).rejects.toThrow();
  });
});
