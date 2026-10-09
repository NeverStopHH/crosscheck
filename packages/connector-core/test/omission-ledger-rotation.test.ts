/**
 * A FULL "THE PERSON WAS NOT TOLD" LEDGER ROTATES (integration review of
 * batch 2, M7; core state/omission-ledger.ts).
 *
 * The three omission ledgers — briefing omissions, landed-change cuts, rests
 * whose recheck never ran — stopped appending at their 64 KiB cap for good.
 * A storm writes the cap in minutes; once its lines aged out of the 7-day
 * window, `doctor` read 0 for ever, while every new omission was refused. The
 * review's probe: a ledger full of 9-day-old lines, then 5 cuts and 5 rest
 * omissions today — the file did not change and both counts read 0.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { MAX_BRIEFING_OMISSION_LEDGER_BYTES, MS_PER_DAY } from "../src/constants.ts";
import { landedProbeCutsPath, readLandedProbeCuts, recordLandedProbeCut } from "../src/state/landed-probe-cuts.ts";
import { rotatedPathOf } from "../src/state/omission-ledger.ts";
import { readRestOmissions, recordRestOmission, restOmissionsPath } from "../src/state/rest-omissions.ts";
import { makeHome } from "./helpers.ts";

const KEY = "k";
const NEW_OMISSIONS = 5;
/** Writers racing on one full ledger, each with one line. */
const RACING_WRITERS = 5;

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

/** A ledger file filled past its cap with copies of one line dated `at`. */
const fillPastCap = async (path: string, at: Date, reason: string): Promise<number> => {
  const line = `${JSON.stringify({ at: at.toISOString(), reason, key: KEY })}\n`;
  const lines = Math.ceil(MAX_BRIEFING_OMISSION_LEDGER_BYTES / line.length) + 1;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, line.repeat(lines), "utf8");
  return lines;
};

describe("a full omission ledger rotates instead of going blind (review batch 2, M7)", () => {
  test("filled with last week's lines, it still counts every omission of today (the review's probe)", async () => {
    // Arrange
    const home = await makeHome("omit-rotate-old");
    homes.push(home);
    const now = new Date();
    const old = new Date(now.getTime() - 9 * MS_PER_DAY);
    await fillPastCap(landedProbeCutsPath(home), old, "budget");
    await fillPastCap(restOmissionsPath(home), old, "rest_unchecked");

    // Act
    for (let index = 0; index < NEW_OMISSIONS; index += 1) {
      await recordLandedProbeCut(home, { key: KEY, reason: "budget", now });
      await recordRestOmission(home, { key: KEY, reason: "rest_unchecked", now });
    }

    // Assert: counted, and the live file restarted under its cap.
    expect((await readLandedProbeCuts(home, KEY, now)).total).toBe(NEW_OMISSIONS);
    expect((await readRestOmissions(home, KEY, now)).total).toBe(NEW_OMISSIONS);
    expect((await stat(landedProbeCutsPath(home))).size).toBeLessThan(MAX_BRIEFING_OMISSION_LEDGER_BYTES);
  });

  test("the lines a rotation moved aside are still counted while they are inside the window", async () => {
    // Arrange: a full ledger of yesterday's cuts.
    const home = await makeHome("omit-rotate-recent");
    homes.push(home);
    const now = new Date();
    const filled = await fillPastCap(landedProbeCutsPath(home), new Date(now.getTime() - MS_PER_DAY), "deadline");

    // Act
    await recordLandedProbeCut(home, { key: KEY, reason: "budget", now });

    // Assert: yesterday's cuts and today's, none lost to the rotation.
    const counts = await readLandedProbeCuts(home, KEY, now);
    expect(counts.byReason).toEqual({ deadline: filled, unanswered: 0, budget: 1 });
    expect(await Bun.file(rotatedPathOf(landedProbeCutsPath(home))).exists()).toBe(true);
  });

  test("hooks that find it full at the same moment rotate it once and lose no line", async () => {
    // Arrange
    const home = await makeHome("omit-rotate-race");
    homes.push(home);
    const now = new Date();
    const filled = await fillPastCap(landedProbeCutsPath(home), new Date(now.getTime() - MS_PER_DAY), "deadline");

    // Act: every writer reads the ledger as full before any of them rotates it.
    await Promise.all(
      Array.from({ length: RACING_WRITERS }, () => recordLandedProbeCut(home, { key: KEY, reason: "budget", now })),
    );

    // Assert
    expect((await readLandedProbeCuts(home, KEY, now)).byReason).toEqual({ deadline: filled, unanswered: 0, budget: RACING_WRITERS });
  });
});
