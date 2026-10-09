/**
 * THE BRIEFING THAT DID NOT ARRIVE (2026-10-08): its local ledger. A
 * SessionStart whose briefing was cut by the budget, by a fault, or by hub
 * reads that did not answer says so in the session (briefing/omission.ts)
 * and books one line here, which `doctor` counts — the reader of an empty
 * session is never the last to know.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

import {
  BRIEFING_OMISSION_WINDOW_DAYS,
  MAX_BRIEFING_OMISSION_LEDGER_BYTES,
} from "../src/constants.ts";
import {
  briefingOmissionsPath,
  readBriefingOmissions,
  recordBriefingOmission,
} from "../src/state/briefing-omissions.ts";
import { withLock } from "../src/spool/lock.ts";
import { makeHome } from "./helpers.ts";

const NOW = new Date("2026-10-08T09:00:00.000Z");
const KEY = "hub-a__github.com-acme-api";
const OTHER_KEY = "hub-a__github.com-acme-web";
const MS_PER_DAY = 86_400_000;

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })));
  homes.length = 0;
});

const freshHome = async (label: string): Promise<string> => {
  const home = await makeHome(label);
  homes.push(home);
  return home;
};

describe("the briefing-omission ledger", () => {
  test("counts this repo's omissions by reason, and the newest", async () => {
    // Arrange
    const home = await freshHome("omit-count");
    await recordBriefingOmission(home, { key: KEY, reason: "budget", now: new Date(NOW.getTime() - 3_600_000) });
    await recordBriefingOmission(home, { key: KEY, reason: "hub", now: NOW });
    await recordBriefingOmission(home, { key: KEY, reason: "error", now: NOW });

    // Act
    const counts = await readBriefingOmissions(home, KEY, NOW);

    // Assert
    expect(counts.total).toBe(3);
    expect(counts.byReason).toEqual({ budget: 1, error: 1, hub: 1 });
    expect(counts.lastAt).toBe(NOW.toISOString());
  });

  test("another repo's omission is not this repo's; one nobody could key is everybody's", async () => {
    // Arrange: a budget the race won before repo identity resolved is unkeyed.
    const home = await freshHome("omit-keys");
    await recordBriefingOmission(home, { key: OTHER_KEY, reason: "hub", now: NOW });
    await recordBriefingOmission(home, { key: null, reason: "budget", now: NOW });

    // Act
    const counts = await readBriefingOmissions(home, KEY, NOW);

    // Assert
    expect(counts.total).toBe(1);
    expect(counts.byReason.budget).toBe(1);
  });

  test("an omission older than the window has stopped counting", async () => {
    // Arrange
    const home = await freshHome("omit-window");
    const outside = new Date(NOW.getTime() - (BRIEFING_OMISSION_WINDOW_DAYS + 1) * MS_PER_DAY);
    await recordBriefingOmission(home, { key: KEY, reason: "hub", now: outside });

    // Act + Assert
    expect((await readBriefingOmissions(home, KEY, NOW)).total).toBe(0);
  });

  test("a ledger it cannot read counts nothing and throws nothing", async () => {
    // Arrange: a directory where the file belongs.
    const home = await freshHome("omit-unreadable");
    await mkdir(briefingOmissionsPath(home), { recursive: true });

    // Act + Assert
    expect((await readBriefingOmissions(home, KEY, NOW)).total).toBe(0);
    await recordBriefingOmission(home, { key: KEY, reason: "hub", now: NOW });
  });

  test("the ledger never grows past its cap, even when it cannot rotate", async () => {
    // Arrange: a ledger already at the cap, and its rotation lock held by
    // another writer for the whole record (review batch 2, M7).
    const home = await freshHome("omit-cap");
    const path = briefingOmissionsPath(home);
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, "x".repeat(MAX_BRIEFING_OMISSION_LEDGER_BYTES));
    const release: { value: () => void } = { value: () => undefined };
    const held = withLock(`${path}.lock`, undefined, () =>
      new Promise<void>((done) => {
        release.value = done;
      }),
    );

    // Act
    try {
      await recordBriefingOmission(home, { key: KEY, reason: "hub", now: NOW });
    } finally {
      release.value();
      await held;
    }

    // Assert
    expect((await stat(path)).size).toBe(MAX_BRIEFING_OMISSION_LEDGER_BYTES);
  });
});
