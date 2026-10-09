/**
 * A REST WHOSE RECHECK NEVER RAN STAYS A PER-FILE, LOCAL LOSS (integration
 * review of batch 2, M3).
 *
 * `rest_unchecked` counts collision files whose 30 s tripwire rest was never
 * followed by its recheck: every target was delivered, and what may be
 * missing is one person told about one file. Sent in the wire report, it
 * turned the hub's agent_event rung `incomplete / telemetry_lost` for the
 * repo's whole coverage for fourteen days. It stays in the capture-loss
 * ledger — doctor and status print it per file (cli test/doctor-losses.test.ts)
 * — and the wire report leaves it out. The hub side of the same run:
 * server test/rest-unchecked-coverage.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { EMPTY_LOSS_REPORT } from "@crosscheck/schema";

import { MAX_LOSS_LEDGER_BYTES } from "../src/constants.ts";
import { repoKey } from "../src/config/paths.ts";
import { readTelemetryLossReport } from "../src/spool/loss-report.ts";
import { lossLedgerPath, readCaptureLosses, recordCaptureLoss } from "../src/state/loss-ledger.ts";
import { makeHome } from "./helpers.ts";

const KEY = repoKey("http://127.0.0.1:9", "github.com/acme/api");
const MINUTE_MS = 60_000;

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

const freshHome = async (label: string): Promise<string> => {
  const home = await makeHome(label);
  homes.push(home);
  return home;
};

describe("rest_unchecked is booked and printed, never sent as telemetry lost (review batch 2, M3)", () => {
  test("a machine that only missed rechecks sends a clean report, and still holds the per-file count", async () => {
    // Arrange
    const home = await freshHome("rest-scope-only");
    await recordCaptureLoss(home, { kind: "rest_unchecked", count: 2, key: KEY, detail: "reap", now: new Date() });

    // Act
    const report = await readTelemetryLossReport(home, KEY);
    const local = await readCaptureLosses(home, KEY);

    // Assert
    expect(report).toEqual(EMPTY_LOSS_REPORT);
    expect(local.byKind["rest_unchecked"]).toBe(2);
  });

  test("beside a real loss, the report names only the real loss and dates it by its own instant", async () => {
    // Arrange: a hook timed out ten minutes ago; a rest went unchecked just now.
    const home = await freshHome("rest-scope-beside");
    const timedOutAt = new Date(Date.now() - 10 * MINUTE_MS);
    await recordCaptureLoss(home, { kind: "hook_timed_out", count: 1, key: KEY, detail: "stop", now: timedOutAt });
    await recordCaptureLoss(home, { kind: "rest_unchecked", count: 3, key: KEY, detail: "session-end", now: new Date() });

    // Act
    const report = await readTelemetryLossReport(home, KEY);

    // Assert
    expect(report.total).toBe(1);
    expect(report.kinds).toEqual({ hook_timed_out: 1 });
    expect(report.newestAt).toBe(timedOutAt.toISOString());
  });

  test("a full ledger that refused only rechecks refuses nothing the hub must hear", async () => {
    // Arrange: a capture-loss ledger past its cap with another repo's lines, so this booking is refused.
    const home = await freshHome("rest-scope-refused");
    const line = `${JSON.stringify({ at: new Date().toISOString(), kind: "hook_timed_out", count: 1, key: "another-repo", detail: "stop" })}\n`;
    await mkdir(dirname(lossLedgerPath(home)), { recursive: true });
    await writeFile(lossLedgerPath(home), line.repeat(Math.ceil(MAX_LOSS_LEDGER_BYTES / line.length) + 1), "utf8");
    await recordCaptureLoss(home, { kind: "rest_unchecked", count: 2, key: KEY, detail: "reap", now: new Date() });

    // Act
    const report = await readTelemetryLossReport(home, KEY);

    // Assert
    expect(report).toEqual(EMPTY_LOSS_REPORT);
    expect((await readCaptureLosses(home, KEY)).byKind["rest_unchecked"]).toBe(2);
  });
});
