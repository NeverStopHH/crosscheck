/**
 * The life ladder's arithmetic and its one file (state/session-lineage.ts).
 * The behaviour it buys — a resumed conversation captured again — is pinned
 * end to end in connector-claude/test/resumed-session.test.ts and its Cursor
 * and ACP twins; this file pins the pieces those runs cannot isolate.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { rm, utimes, writeFile } from "node:fs/promises";

import { MAX_SPOOL_AGE_DAYS, MS_PER_DAY, REGISTER_LADDER_MAX_ATTEMPTS } from "../src/constants.ts";
import { sessionLineagePathForSlug, sessionSlug } from "../src/config/paths.ts";
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
