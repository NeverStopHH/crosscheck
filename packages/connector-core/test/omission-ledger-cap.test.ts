/**
 * AN OMISSION LEDGER AT ITS CAP KEEPS COUNTING (batch-2 integration review,
 * M7). Appends stopped at MAX_BRIEFING_OMISSION_LEDGER_BYTES with no
 * rotation, and the reader counts only the last BRIEFING_OMISSION_WINDOW_DAYS
 * — so once the file filled, every new landed-check cut, briefing omission,
 * rest omission and cut tripwire line went unrecorded, and doctor read 0 for
 * good. At the cap the ledger now drops the lines the window no longer
 * counts, and the new line is kept.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BRIEFING_OMISSION_WINDOW_DAYS, MAX_BRIEFING_OMISSION_LEDGER_BYTES } from "../src/constants.ts";
import { landedProbeCutsPath, readLandedProbeCuts, recordLandedProbeCut } from "../src/state/landed-probe-cuts.ts";
import { readRestOmissions, recordRestOmission, restOmissionsPath } from "../src/state/rest-omissions.ts";

const MS_PER_DAY = 86_400_000;
const KEY = "k";
const NEW_LINES = 5;

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

const home = async (): Promise<string> => {
  const made = await mkdtemp(join(tmpdir(), "cx-omission-cap-"));
  homes.push(made);
  await mkdir(join(made, "state"), { recursive: true });
  return made;
};

/** A ledger past its cap, every line `ageDays` old. */
const filled = async (path: string, reason: string, ageDays: number): Promise<void> => {
  const at = new Date(Date.now() - ageDays * MS_PER_DAY).toISOString();
  const line = `${JSON.stringify({ at, reason, key: KEY })}\n`;
  await writeFile(path, line.repeat(Math.ceil(MAX_BRIEFING_OMISSION_LEDGER_BYTES / line.length) + 1));
};

describe("an omission ledger at its cap", () => {
  test("drops the lines the window no longer counts and keeps every new one", async () => {
    // Arrange
    const h = await home();
    await filled(landedProbeCutsPath(h), "budget", BRIEFING_OMISSION_WINDOW_DAYS + 2);
    await filled(restOmissionsPath(h), "tripwire_cut", BRIEFING_OMISSION_WINDOW_DAYS + 2);
    const now = new Date();

    // Act
    for (let index = 0; index < NEW_LINES; index += 1) {
      await recordLandedProbeCut(h, { key: KEY, reason: "budget", now });
      await recordRestOmission(h, { key: KEY, reason: "tripwire_cut", now });
    }

    // Assert
    expect((await readLandedProbeCuts(h, KEY, now)).total).toBe(NEW_LINES);
    expect((await readRestOmissions(h, KEY, now)).byReason.tripwire_cut).toBe(NEW_LINES);
    expect((await stat(landedProbeCutsPath(h))).size).toBeLessThan(MAX_BRIEFING_OMISSION_LEDGER_BYTES);
  });

  test("full of lines the window still counts, it stays bounded and the count stands", async () => {
    // Arrange
    const h = await home();
    await filled(landedProbeCutsPath(h), "budget", 1);
    const now = new Date();
    const before = (await readLandedProbeCuts(h, KEY, now)).total;

    // Act
    await recordLandedProbeCut(h, { key: KEY, reason: "budget", now });

    // Assert
    expect((await readLandedProbeCuts(h, KEY, now)).total).toBe(before);
    expect((await stat(landedProbeCutsPath(h))).size).toBeLessThan(MAX_BRIEFING_OMISSION_LEDGER_BYTES * 2);
  });
});
