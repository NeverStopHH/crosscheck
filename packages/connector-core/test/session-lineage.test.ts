/**
 * The life ladder's arithmetic and its one file (state/session-lineage.ts).
 * The behaviour it buys — a resumed conversation captured again — is pinned
 * end to end in connector-claude/test/resumed-session.test.ts and its Cursor
 * and ACP twins; this file pins the pieces those runs cannot isolate.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";

import {
  MAX_SPOOL_AGE_DAYS,
  MS_PER_DAY,
  REFUSED_END_GRACE_MS,
  REFUSED_LIFE_KEEP_DAYS,
  REFUSED_LIVES_MAX,
  REGISTER_LADDER_MAX_ATTEMPTS,
} from "../src/constants.ts";
import {
  readTextOrNull,
  sessionLineagePathForSlug,
  sessionSlug,
  spoolDataPath,
  spoolDir,
  spoolRefusedLivesPath,
} from "../src/config/paths.ts";
import { readRefusedLives, recordRefusedLife } from "../src/spool/refused-lives.ts";
import {
  ladderRungs,
  ladderStart,
  lifeRungOf,
  lifeSessionId,
  readEndedLifeRung,
  reapStaleLineages,
  recordEndedLife,
} from "../src/state/session-lineage.ts";
import { makeHome } from "./helpers.ts";

const BASE = "cc_lineage-uuid";
const HOST_KEY = "lineage-uuid";
const homes: string[] = [];

afterAll(async () => {
  await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })));
});

const home = async (label: string): Promise<string> => {
  const path = await makeHome(label);
  homes.push(path);
  return path;
};

describe("life ids", () => {
  test("rung 0 is the base id; every other rung carries ~r<n>", () => {
    expect(lifeSessionId(BASE, 0)).toBe(BASE);
    expect(lifeSessionId(BASE, 7)).toBe(`${BASE}~r7`);
  });

  test("an id reads back as its rung, and anything else as no rung", () => {
    expect(lifeRungOf(BASE, BASE)).toBe(0);
    expect(lifeRungOf(BASE, `${BASE}~r12`)).toBe(12);
    expect(lifeRungOf(BASE, `${BASE}~r0`)).toBeNull();
    expect(lifeRungOf(BASE, `${BASE}~r-1`)).toBeNull();
    expect(lifeRungOf(BASE, `${BASE}~r1x`)).toBeNull();
    expect(lifeRungOf(BASE, "cc_other-uuid~r3")).toBeNull();
    expect(lifeRungOf(BASE, null)).toBeNull();
  });
});

describe("the walk", () => {
  test("tries the start, the next rung, then gallops", () => {
    expect(ladderRungs(5).slice(0, 5)).toEqual([5, 6, 7, 9, 13]);
    expect(ladderRungs(0).length).toBe(REGISTER_LADDER_MAX_ATTEMPTS);
  });

  test("starts on the live life, or above an end written at or above it — never on an ended rung", () => {
    expect(ladderStart(BASE, null, null)).toBe(0);
    expect(ladderStart(BASE, `${BASE}~r4`, null)).toBe(4);
    expect(ladderStart(BASE, `${BASE}~r4`, 2)).toBe(4);
    expect(ladderStart(BASE, `${BASE}~r4`, 4)).toBe(5);
    expect(ladderStart(BASE, null, 6)).toBe(7);
    expect(ladderStart(BASE, null, 0)).toBe(1);
    expect(ladderStart(BASE, "cc_somebody-else", 1)).toBe(2);
  });
});

describe("the ended-life note", () => {
  test("an end writes the life it closed, and the next register reads its rung", async () => {
    // Arrange
    const dir = await home("lineage-roundtrip");

    // Act
    await recordEndedLife(dir, HOST_KEY, `${BASE}~r3`, new Date());

    // Assert
    expect(await readEndedLifeRung(dir, HOST_KEY, BASE)).toBe(3);
  });

  test("an absent or edited note is no hint at all", async () => {
    // Arrange
    const dir = await home("lineage-edited");
    expect(await readEndedLifeRung(dir, HOST_KEY, BASE)).toBeNull();
    await recordEndedLife(dir, HOST_KEY, `${BASE}~r3`, new Date());
    await writeFile(sessionLineagePathForSlug(dir, sessionSlug(HOST_KEY)), "not json\n");

    // Act + Assert
    expect(await readEndedLifeRung(dir, HOST_KEY, BASE)).toBeNull();
  });

  test(`a note older than ${String(MAX_SPOOL_AGE_DAYS)} days is reaped, a fresh one kept`, async () => {
    // Arrange
    const dir = await home("lineage-reap");
    const now = new Date();
    await recordEndedLife(dir, "old-uuid", "cc_old-uuid~r1", now);
    await recordEndedLife(dir, "fresh-uuid", "cc_fresh-uuid~r1", now);
    const past = new Date(now.getTime() - (MAX_SPOOL_AGE_DAYS + 1) * MS_PER_DAY);
    await utimes(sessionLineagePathForSlug(dir, sessionSlug("old-uuid")), past, past);

    // Act
    const reaped = await reapStaleLineages(dir, now);

    // Assert
    expect(reaped).toBe(1);
    expect(await readEndedLifeRung(dir, "old-uuid", "cc_old-uuid")).toBeNull();
    expect(await readEndedLifeRung(dir, "fresh-uuid", "cc_fresh-uuid")).toBe(1);
  });
});

/**
 * THE REFUSED-LIVES NOTE STAYS BOUNDED (review finding 8). It was append-only
 * and read on every drain: lines older than MAX_SPOOL_AGE_DAYS were ignored
 * on read and never removed, so it only grew.
 */
describe("the refused-lives note", () => {
  const KEY = "repo-key";
  const linesOf = async (dir: string): Promise<readonly string[]> =>
    ((await readTextOrNull(spoolRefusedLivesPath(dir, KEY))) ?? "").split("\n").filter((line) => line.length > 0);

  test("a write drops the lines past their age", async () => {
    // Arrange: two stale lives — past the least an entry is kept (review-2 round 8, H1) — and one young one on file
    const dir = await home("refused-prune");
    const now = new Date();
    const stale = new Date(now.getTime() - (REFUSED_LIFE_KEEP_DAYS + 1) * MS_PER_DAY);
    await recordRefusedLife(dir, KEY, "cc_old-1", stale);
    await recordRefusedLife(dir, KEY, "cc_old-2", stale);
    await recordRefusedLife(dir, KEY, "cc_young", now);

    // Act
    await recordRefusedLife(dir, KEY, "cc_new", now);

    // Assert
    expect(await linesOf(dir)).toHaveLength(2);
    expect([...(await readRefusedLives(dir, KEY, now))].sort()).toEqual(["cc_new", "cc_young"]);
  });

  test(`a write keeps at most the newest ${String(REFUSED_LIVES_MAX)} lives`, async () => {
    // Arrange
    const dir = await home("refused-cap");
    const now = new Date();
    for (let index = 0; index < REFUSED_LIVES_MAX; index += 1) {
      await recordRefusedLife(dir, KEY, `cc_life-${String(index)}`, now);
    }

    // Act
    await recordRefusedLife(dir, KEY, "cc_newest", now);

    // Assert: the oldest went, the newest stayed
    const lives = await readRefusedLives(dir, KEY, now);
    expect(await linesOf(dir)).toHaveLength(REFUSED_LIVES_MAX);
    expect(lives.has("cc_newest")).toBe(true);
    expect(lives.has("cc_life-0")).toBe(false);
  });

  test("a full note never evicts a life that still owns records on disk: the oldest without any go first (review-2 round 9, H2)", async () => {
    // Arrange: the oldest entry's host session still has a straggler on disk; the rest own nothing
    const dir = await home("refused-owning");
    const now = new Date();
    await recordRefusedLife(dir, KEY, "cc_owner", now);
    await mkdir(spoolDir(dir, KEY), { recursive: true });
    await writeFile(spoolDataPath(dir, KEY, sessionSlug("owner")), `${JSON.stringify({ id: "env_straggler" })}\n`);
    for (let index = 1; index < REFUSED_LIVES_MAX; index += 1) {
      await recordRefusedLife(dir, KEY, `cc_life-${String(index)}`, now);
    }

    // Act
    await recordRefusedLife(dir, KEY, "cc_newest", now);

    // Assert
    const lives = await readRefusedLives(dir, KEY, now);
    expect(lives.has("cc_owner")).toBe(true);
    expect(lives.has("cc_newest")).toBe(true);
    expect(lives.has("cc_life-1")).toBe(false);
  });

  test("a SessionEnd's entry goes once its spool is empty and its grace is over (review-2 round 9, H2)", async () => {
    // Arrange: an end written down past the grace a hook still in flight has, nothing on disk
    const dir = await home("refused-end");
    const now = new Date();
    await recordRefusedLife(dir, KEY, "cc_ended", new Date(now.getTime() - REFUSED_END_GRACE_MS - MS_PER_DAY / 24), "end");
    await recordRefusedLife(dir, KEY, "cc_ended-recently", now, "end");

    // Act
    await recordRefusedLife(dir, KEY, "cc_healed", now);

    // Assert: the old end gone, the recent one and the heal's kept
    expect([...(await readRefusedLives(dir, KEY, now))].sort()).toEqual(["cc_ended-recently", "cc_healed"]);
  });
});
