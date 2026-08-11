/**
 * The per-repo delivered-hint hash store (DESIGN.md §3 echo-loop exclusion).
 *
 * Session state dies at SessionEnd, but the §3 mandate carries no session
 * qualifier: a teammate hint delivered YESTERDAY, quoted in TODAY's diagnosis
 * turn, must still never come back as the reader's own derived draft. The
 * store keeps only truncated SHA-256 hashes of normalized bodies — never the
 * bodies — bounded FIFO per repo, fail-open on every read like all capture
 * state.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";

import { MAX_DELIVERED_HINT_HASHES_PER_REPO } from "../src/constants.ts";
import { deliveredHintsPath } from "../src/config/paths.ts";
import {
  readDeliveredHintHashes,
  recordDeliveredHintHash,
} from "../src/hints/delivered-store.ts";
import { hintBodyHash } from "../src/hints/echo.ts";
import { makeHome } from "./helpers.ts";

const REPO_KEY = "0123456789abcdef0123456789abcdef";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })));
  homes.length = 0;
});

const freshHome = async (): Promise<string> => {
  const home = await makeHome("delivered-store");
  homes.push(home);
  return home;
};

describe("delivered-hint hash store", () => {
  test("hashes recorded for a repo read back in delivery order", async () => {
    // Arrange
    const home = await freshHome();
    const first = hintBodyHash("The refresh 500s trace back to the rotated key");
    const second = hintBodyHash("The cursor id is stale after the reap");

    // Act
    await recordDeliveredHintHash(home, REPO_KEY, first);
    await recordDeliveredHintHash(home, REPO_KEY, second);

    // Assert
    expect(await readDeliveredHintHashes(home, REPO_KEY)).toEqual([
      first,
      second,
    ]);
  });

  test("an already-recorded hash is not appended twice", async () => {
    // Arrange
    const home = await freshHome();
    const hash = hintBodyHash("The refresh 500s trace back to the rotated key");

    // Act
    await recordDeliveredHintHash(home, REPO_KEY, hash);
    await recordDeliveredHintHash(home, REPO_KEY, hash);

    // Assert
    expect(await readDeliveredHintHashes(home, REPO_KEY)).toEqual([hash]);
  });

  test("the store is FIFO-capped per repo — the oldest hashes fall out", async () => {
    // Arrange: two more than the cap, so the first two must age out
    const home = await freshHome();
    const total = MAX_DELIVERED_HINT_HASHES_PER_REPO + 2;

    // Act
    for (let index = 0; index < total; index += 1) {
      await recordDeliveredHintHash(home, REPO_KEY, hintBodyHash(`body ${String(index)}`));
    }

    // Assert
    const stored = await readDeliveredHintHashes(home, REPO_KEY);
    expect(stored.length).toBe(MAX_DELIVERED_HINT_HASHES_PER_REPO);
    expect(stored[0]).toBe(hintBodyHash("body 2"));
    expect(stored[stored.length - 1]).toBe(hintBodyHash(`body ${String(total - 1)}`));
  });

  test("a missing or corrupt store file reads as empty, never a throw", async () => {
    // Arrange
    const home = await freshHome();

    // Act + Assert: missing
    expect(await readDeliveredHintHashes(home, REPO_KEY)).toEqual([]);

    // Arrange: corrupt — capture state fails open like everything else
    await recordDeliveredHintHash(home, REPO_KEY, hintBodyHash("a real body"));
    await writeFile(deliveredHintsPath(home, REPO_KEY), "{not json", "utf8");

    // Act + Assert
    expect(await readDeliveredHintHashes(home, REPO_KEY)).toEqual([]);
  });

  test("two repos never share a store", async () => {
    // Arrange
    const home = await freshHome();
    const otherKey = "ffffffffffffffffffffffffffffffff";
    const hash = hintBodyHash("The refresh 500s trace back to the rotated key");

    // Act
    await recordDeliveredHintHash(home, REPO_KEY, hash);

    // Assert
    expect(await readDeliveredHintHashes(home, otherKey)).toEqual([]);
  });
});
