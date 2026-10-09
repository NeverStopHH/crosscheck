/**
 * THREE LEDGERS UNDER RACING HOOKS (integration review of batch 2, M9).
 *
 * Each of these was a read-modify-write with no lock, and hooks run in
 * parallel. The review's probe, twelve processes writing once each:
 *   - the refused-loss marker (state/loss-refusals.ts) — the "refused, never
 *     dropped" count once `losses.jsonl` is full — came out at 1, once 2;
 *   - the foreign-hub ledger (state/foreign-hub.ts) held 1 line of 12;
 *   - the fired-hooks record (state/fired-markers.ts) held 1 key of 12, so
 *     eleven hooks read as never fired.
 * Every writer read before any wrote. Pinned here with the same twelve real
 * processes released at one instant.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { MAX_LOSS_LEDGER_BYTES } from "../src/constants.ts";
import { hooksFiredPath } from "../src/config/paths.ts";
import { readHooksFired, recordHookFired } from "../src/state/fired-markers.ts";
import { foreignHubLedgerPath } from "../src/state/foreign-hub.ts";
import { lossLedgerPath } from "../src/state/loss-ledger.ts";
import { readLossRefusals } from "../src/state/loss-refusals.ts";
import { makeHome } from "./helpers.ts";

const WORKER = resolve(import.meta.dir, "fixtures", "ledger-race-writer.ts");
const WRITERS = 12;
/** Long enough for every process to boot before the shared instant. */
const START_DELAY_MS = 1_500;
const STORM_TIMEOUT_MS = 60_000;

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

const freshHome = async (label: string): Promise<string> => {
  const home = await makeHome(label);
  homes.push(home);
  await mkdir(join(home, "state"), { recursive: true });
  return home;
};

/** WRITERS processes, each writing one `kind` entry at the same instant. */
const storm = async (kind: string, home: string): Promise<void> => {
  const startAt = Date.now() + START_DELAY_MS;
  const writers = Array.from({ length: WRITERS }, (_, index) =>
    Bun.spawn({
      cmd: [process.execPath, WORKER, kind, home, String(index), String(startAt)],
      // This run's env, so the network guard and its temp home reach the child.
      env: { ...process.env },
      stdout: "ignore",
      stderr: "pipe",
    }),
  );
  const codes = await Promise.all(writers.map((writer) => writer.exited));
  expect(codes).toEqual(Array.from({ length: WRITERS }, () => 0));
};

describe("racing hooks lose no ledger update (review batch 2, M9)", () => {
  test(
    "twelve hooks of twelve events each leave their own fired stamp",
    async () => {
      // Arrange
      const home = await freshHome("race-fired");

      // Act
      await storm("fired", home);

      // Assert
      expect(Object.keys(await readHooksFired(home, "repo-key")).sort()).toEqual(
        Array.from({ length: WRITERS }, (_, index) => `hook-${String(index)}`).sort(),
      );
    },
    STORM_TIMEOUT_MS,
  );

  test("a fired record written before per-hook files is still read, and the later stamp wins", async () => {
    // Arrange: the combined file an earlier connector wrote, then one new stamp.
    const home = await freshHome("fired-legacy");
    const earlier = "2026-10-01T10:00:00.000Z";
    const later = new Date("2026-10-09T10:00:00.000Z");
    await writeFile(hooksFiredPath(home, "repo-key"), `${JSON.stringify({ stop: earlier, "session-start": earlier })}\n`, "utf8");

    // Act
    await recordHookFired(home, "repo-key", "session-start", later);

    // Assert
    expect(await readHooksFired(home, "repo-key")).toEqual({ stop: earlier, "session-start": later.toISOString() });
  });

  test(
    "twelve losses refused by a full ledger are counted twelve times",
    async () => {
      // Arrange: a capture-loss ledger past its cap, so every write is refused.
      const home = await freshHome("race-refused");
      const line = `${JSON.stringify({ at: new Date().toISOString(), kind: "hook_timed_out", count: 1, key: null, detail: "filler" })}\n`;
      await writeFile(lossLedgerPath(home), line.repeat(Math.ceil(MAX_LOSS_LEDGER_BYTES / line.length) + 1), "utf8");

      // Act
      await storm("refused-loss", home);

      // Assert
      expect((await readLossRefusals(home))?.refused).toEqual({ hook_timed_out: WRITERS });
    },
    STORM_TIMEOUT_MS,
  );

  test(
    "twelve refused sessions starting at once are twelve lines",
    async () => {
      // Arrange
      const home = await freshHome("race-foreign");

      // Act
      await storm("foreign-hub", home);

      // Assert
      const ledger = await readFile(foreignHubLedgerPath(home), "utf8");
      expect(ledger.split("\n").filter((entry) => entry.includes('"session"'))).toHaveLength(WRITERS);
    },
    STORM_TIMEOUT_MS,
  );
});
