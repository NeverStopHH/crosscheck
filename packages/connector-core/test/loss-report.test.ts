/**
 * LOSS-7 (docs/1.0/loss-accounting.md §7): the report folds EVERY ledger —
 * drops by reason, the unrecorded marker, the capture-loss ledger — into the
 * counts-and-kinds shape the hub reads, and the two commands print it in one
 * spelling.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { EMPTY_LOSS_REPORT, MAX_LOSS_COUNT, TelemetryLossReportSchema } from "@crosscheck/schema";

import { HUB_COVERAGE_WINDOW_DAYS, MAX_LOSS_LEDGER_BYTES } from "../src/constants.ts";
import {
  ensureDir,
  repoKey,
  sessionSlug,
  spoolDir,
  spoolDropsArchivePath,
  spoolDropsPath,
  spoolUnrecordedDropsPath,
  writePrivateFile,
} from "../src/config/paths.ts";
import { archiveLedger, newestDropMs, readDropDetail, recordDrop } from "../src/spool/drops.ts";
import {
  formatLossLines,
  hasRecentLoss,
  readLocalLosses,
  toWireReport,
} from "../src/spool/loss-report.ts";
import { lossLedgerPath, recordCaptureLoss, recordHookTimeout } from "../src/state/loss-ledger.ts";
import { makeHome } from "./helpers.ts";

const KEY = repoKey("http://127.0.0.1:9", "github.com/acme/api");
const SLUG = sessionSlug("session-report");
const T0 = new Date("2026-09-01T08:00:00.000Z");
const T1 = new Date("2026-09-02T08:00:00.000Z");
const T2 = new Date("2026-09-03T08:00:00.000Z");
const T3 = new Date("2026-09-04T08:00:00.000Z");
const T4 = new Date("2026-09-05T08:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.map((path) => rm(path, { recursive: true, force: true })));
  homes.length = 0;
});

const home = async (): Promise<string> => {
  const path = await makeHome("loss-report");
  homes.push(path);
  return path;
};

describe("LOSS-7: the report folds every ledger", () => {
  test("drop reasons become wire kinds; the marker and the capture ledger join the total and the span", async () => {
    // Arrange
    const path = await home();
    await recordDrop(path, KEY, SLUG, 1, "cap", T0);
    await recordDrop(path, KEY, SLUG, 3, "expired", T1);
    await recordDrop(path, KEY, SLUG, 2, "ignored", T2, { claim_revalidation: 2 });
    await ensureDir(spoolDir(path, KEY));
    await writePrivateFile(
      spoolUnrecordedDropsPath(path, KEY),
      `${JSON.stringify({ at: T3.toISOString(), count: 4, reason: "write-failed" })}\n`,
    );
    await recordCaptureLoss(path, { kind: "hook_timed_out", count: 1, key: KEY, detail: "post-tool-use", now: T4 });

    // Act
    const local = await readLocalLosses(path, KEY);

    // Assert
    expect(local.report).toEqual({
      total: 11,
      kinds: { spool_refused: 5, spool_expired: 3, hub_ignored: 2, hook_timed_out: 1 },
      oldestAt: T0.toISOString(),
      newestAt: T4.toISOString(),
      ignoredNewestAt: T2.toISOString(),
    });
    expect(local.isFloor).toBe(true);
    expect(local.drops.ignoredRecordKinds["claim_revalidation"]).toBe(2);
  });

  test("a clean machine reports zero, as a statement rather than a silence", async () => {
    // Act
    const local = await readLocalLosses(await home(), KEY);

    // Assert
    expect(local.report).toEqual(EMPTY_LOSS_REPORT);
    expect(local.isFloor).toBe(false);
  });

  test("an archive folded before reasons were kept reports its count as unattributed", async () => {
    // Arrange: the aggregate line reap wrote on the tree before this note
    const path = await home();
    await ensureDir(spoolDir(path, KEY));
    await writePrivateFile(
      spoolDropsArchivePath(path, KEY),
      `${JSON.stringify({ at: T2.toISOString(), oldestAt: T0.toISOString(), count: 7, entries: 2, malformed: 0, reason: "aggregated" })}\n`,
    );

    // Act
    const local = await readLocalLosses(path, KEY);

    // Assert
    expect(local.report.total).toBe(7);
    expect(local.report.kinds).toEqual({ unattributed: 7 });
    expect(local.report.oldestAt).toBe(T0.toISOString());
    expect(local.report.newestAt).toBe(T2.toISOString());
  });

  test("an archived ledger keeps its reasons and its ignored kinds through the fold", async () => {
    // Arrange
    const path = await home();
    await recordDrop(path, KEY, SLUG, 3, "expired", T1);
    await recordDrop(path, KEY, SLUG, 2, "ignored", T2, { claim_revalidation: 2 });

    // Act
    await archiveLedger(path, KEY, spoolDropsPath(path, KEY, SLUG));
    await rm(spoolDropsPath(path, KEY, SLUG));
    const detail = await readDropDetail(path, KEY);
    const local = await readLocalLosses(path, KEY);

    // Assert
    expect(detail.byReason).toEqual({ expired: 3, ignored: 2 });
    expect(detail.ignoredRecordKinds).toEqual({ claim_revalidation: 2 });
    expect(local.report.kinds).toEqual({ spool_expired: 3, hub_ignored: 2 });
  });
});

describe("an instant a ledger cannot date never reaches the wire, and never narrows the span", () => {
  /**
   * Review H2: undatable content used to make the span unknown FOR GOOD. It
   * now takes the one upper bound the filesystem holds — no line in a file
   * was written after the file's last modification — so the newest is that
   * mtime (later than the truth: the weakening side), the oldest stays
   * unknown, and the loss leaves the hub's window like any other.
   */
  const pin = (path: string, at: Date): Promise<void> => utimes(path, at, at);
  const MONTH_AFTER_T4 = new Date(T4.getTime() + 30 * DAY_MS);

  test("a garbled capture-ledger instant still counts, is bounded by the file's mtime, and ages out", async () => {
    // Arrange: a dated drop, then a capture-ledger line a hand edit left undatable
    const path = await home();
    await recordDrop(path, KEY, SLUG, 3, "expired", T1);
    await ensureDir(join(path, "state"));
    await writeFile(
      lossLedgerPath(path),
      `${JSON.stringify({ at: "yesterday", kind: "hook_timed_out", count: 1, key: KEY, detail: "stop" })}\n`,
    );
    await pin(lossLedgerPath(path), T4);

    // Act
    const { report } = await readLocalLosses(path, KEY);

    // Assert: counted; since-when unknown; newest no earlier than the file says
    expect(report.total).toBe(4);
    expect(report.oldestAt).toBeNull();
    expect(report.newestAt).toBe(T4.toISOString());
    expect(hasRecentLoss(report, MONTH_AFTER_T4)).toBe(false);
    expect(TelemetryLossReportSchema.safeParse(report).success).toBe(true);
  });

  test("a garbled marker instant is bounded by the marker's mtime, never a string on the wire", async () => {
    // Arrange
    const path = await home();
    await recordDrop(path, KEY, SLUG, 3, "expired", T1);
    await writePrivateFile(
      spoolUnrecordedDropsPath(path, KEY),
      `${JSON.stringify({ at: "not-a-date", count: 4, reason: "write-failed" })}\n`,
    );
    await pin(spoolUnrecordedDropsPath(path, KEY), T4);

    // Act
    const { report } = await readLocalLosses(path, KEY);

    // Assert
    expect(report.total).toBe(7);
    expect(report.newestAt).toBe(T4.toISOString());
    expect(TelemetryLossReportSchema.safeParse(report).success).toBe(true);
  });

  test("an unreadable ledger line is at least one loss — unattributed, bounded, never a report of zero", async () => {
    // Arrange: a torn .drops line and a garbled capture-ledger line, nothing else
    const path = await home();
    await ensureDir(spoolDir(path, KEY));
    await writeFile(spoolDropsPath(path, KEY, SLUG), '{"at":"2026-09-0\n', "utf8");
    await pin(spoolDropsPath(path, KEY, SLUG), T3);
    await ensureDir(join(path, "state"));
    await writeFile(lossLedgerPath(path), "garbage\n", "utf8");
    await pin(lossLedgerPath(path), T4);

    // Act
    const local = await readLocalLosses(path, KEY);

    // Assert: a line exists because a loss was written; its count is unknown, so at least one
    expect(local.report.total).toBe(2);
    expect(local.report.kinds).toEqual({ unattributed: 2 });
    expect(local.report.newestAt).toBe(T4.toISOString());
    expect(local.isFloor).toBe(true);
  });

  test("PROBE 2: one torn line in the machine-wide ledger charges every repo, and the charge ages out", async () => {
    // Arrange: another repo's torn line, nothing else on the machine
    const path = await home();
    await ensureDir(join(path, "state"));
    await writeFile(lossLedgerPath(path), '{"at":"2026-09-01T08:00:00.000Z","kind":"hook_timed_out","count":1,"key":"x","det\n', "utf8");
    await pin(lossLedgerPath(path), T4);

    // Act
    const { report } = await readLocalLosses(path, KEY);

    // Assert
    expect(report).toEqual({ total: 1, kinds: { unattributed: 1 }, oldestAt: null, newestAt: T4.toISOString() });
    expect(hasRecentLoss(report, T4)).toBe(true);
    expect(hasRecentLoss(report, MONTH_AFTER_T4)).toBe(false);
  });

  test("PROBE 4: a torn line folded into the archive keeps its bound, so the archive ages out too", async () => {
    // Arrange: a dated drop plus a torn line, the ledger last written at T1, then folded
    const path = await home();
    await recordDrop(path, KEY, SLUG, 3, "expired", T0);
    const ledger = spoolDropsPath(path, KEY, SLUG);
    await writeFile(ledger, `${await Bun.file(ledger).text()}{"at":"2026\n`, "utf8");
    await pin(ledger, T1);

    // Act
    await archiveLedger(path, KEY, ledger);
    await rm(ledger);
    const { report } = await readLocalLosses(path, KEY);

    // Assert: the fold carried the bound, not "unknown for ever"
    expect(report.total).toBe(4);
    expect(report.newestAt).toBe(T1.toISOString());
    expect(hasRecentLoss(report, MONTH_AFTER_T4)).toBe(false);
  });

  test("PROBE 4: a ledger with no datable line ages by its mtime, so reap can fold it", async () => {
    // Arrange
    const path = await home();
    await ensureDir(spoolDir(path, KEY));
    const ledger = spoolDropsPath(path, KEY, SLUG);
    await writeFile(ledger, '{"at":"x\n', "utf8");
    await pin(ledger, T2);

    // Act
    const newest = await newestDropMs(ledger);

    // Assert
    expect(newest).toBe(T2.getTime());
  });

  test("PROBE 1 (review H1): a ledger other repos filled still reports this repo's refused loss, dated", async () => {
    // Arrange: the machine-wide ledger at its cap with ANOTHER repo's lines,
    // then a hook in this repo times out and the ledger refuses the line
    const path = await home();
    await ensureDir(join(path, "state"));
    const other = `${JSON.stringify({ at: T0.toISOString(), kind: "hook_timed_out", count: 1, key: "another-repo", detail: "stop" })}\n`;
    await writeFile(lossLedgerPath(path), other.repeat(Math.ceil(MAX_LOSS_LEDGER_BYTES / other.length)), "utf8");
    await recordHookTimeout(path, "post-tool-use", KEY, T4);

    // Act
    const local = await readLocalLosses(path, KEY);

    // Assert: a loss, recent, never the report of zero it used to be
    expect(local.report.total).toBeGreaterThan(0);
    expect(local.report.kinds["hook_timed_out"]).toBe(1);
    expect(local.report.newestAt).toBe(T4.toISOString());
    expect(hasRecentLoss(local.report, T4)).toBe(true);
    expect(local.isFloor).toBe(true);
  });

  test("a capture ledger at its cap with no readable marker reads its newest as unknown", async () => {
    // Arrange: full, with this repo's month-old lines, and no refusal marker
    const path = await home();
    await ensureDir(join(path, "state"));
    const old = `${JSON.stringify({ at: T0.toISOString(), kind: "hook_timed_out", count: 1, key: KEY, detail: "stop" })}\n`;
    await writeFile(lossLedgerPath(path), old.repeat(Math.ceil(MAX_LOSS_LEDGER_BYTES / old.length)), "utf8");

    // Act
    const local = await readLocalLosses(path, KEY);

    // Assert: a refusal whose marker failed would be invisible, so the newest may not be T0
    expect(local.report.newestAt).toBeNull();
    expect(local.report.oldestAt).toBe(T0.toISOString());
  });

  test("an undatable .drops line is bounded by its ledger's mtime too", async () => {
    // Arrange
    const path = await home();
    await recordDrop(path, KEY, SLUG, 3, "expired", T1);
    const ledger = spoolDropsPath(path, KEY, SLUG);
    await writeFile(
      ledger,
      `${await Bun.file(ledger).text()}${JSON.stringify({ at: "soon", count: 2, reason: "rejected" })}\n`,
    );
    await utimes(ledger, T4, T4);

    // Act
    const { report } = await readLocalLosses(path, KEY);

    // Assert
    expect(report.total).toBe(5);
    expect(report.oldestAt).toBeNull();
    expect(report.newestAt).toBe(T4.toISOString());
  });
});

describe("review M3: the ignored kind and its remedy follow the window, not the archive's lifetime", () => {
  const ANCIENT = new Date("2025-01-01T00:00:00.000Z");

  test("PROBE 5: an ignored drop from 2025 beside a fresh cap drop does not tell anyone to upgrade the hub", async () => {
    // Arrange: an ignored drop folded long ago, then an unrelated loss today
    const path = await home();
    await recordDrop(path, KEY, SLUG, 2, "ignored", ANCIENT, { claim_revalidation: 2 });
    await archiveLedger(path, KEY, spoolDropsPath(path, KEY, SLUG));
    await rm(spoolDropsPath(path, KEY, SLUG));
    await recordDrop(path, KEY, sessionSlug("s2"), 1, "cap", T4);

    // Act
    const local = await readLocalLosses(path, KEY);
    const lines = formatLossLines(local, T4);

    // Assert: the wire dates the ignored kind; doctor names it as earlier, not as a remedy
    expect(local.report.ignoredNewestAt).toBe(ANCIENT.toISOString());
    expect(lines.ignored).toBeNull();
    expect(lines.ignoredEarlier).toContain("2 records ignored by the hub before its 14-day window");
  });

  test("an ignored drop inside the window still names the remedy", async () => {
    // Arrange
    const path = await home();
    await recordDrop(path, KEY, SLUG, 2, "ignored", T4, { claim_revalidation: 2 });

    // Act
    const local = await readLocalLosses(path, KEY);

    // Assert
    expect(local.report.ignoredNewestAt).toBe(T4.toISOString());
    expect(formatLossLines(local, T4).ignored).toContain("upgrade the hub");
  });
});

describe("review M1: a ledger that exists and cannot be read is a loss, never zero", () => {
  test("PROBE 3: an archive that will not parse keeps the count it still names", async () => {
    // Arrange: an archive line missing oldestAt — every field the reader needs but one
    const path = await home();
    await ensureDir(spoolDir(path, KEY));
    await writePrivateFile(
      spoolDropsArchivePath(path, KEY),
      `${JSON.stringify({ at: T4.toISOString(), count: 382, entries: 343, malformed: 0, reason: "aggregated" })}\n`,
    );

    // Act
    const { report } = await readLocalLosses(path, KEY);

    // Assert
    expect(report.total).toBe(382);
    expect(report.kinds).toEqual({ unattributed: 382 });
  });

  test("PROBE 3: a torn archive is at least one loss", async () => {
    // Arrange
    const path = await home();
    await ensureDir(spoolDir(path, KEY));
    await writePrivateFile(
      spoolDropsArchivePath(path, KEY),
      `{"at":"${T4.toISOString()}","oldestAt":"${T0.toISOString()}","count":382,"entr\n`,
    );

    // Act
    const { report } = await readLocalLosses(path, KEY);

    // Assert
    expect(report.total).toBeGreaterThanOrEqual(1);
    expect(report.kinds["unattributed"]).toBe(report.total);
  });

  test.each([
    ["a .drops file nobody may read (mode 000)", async (path: string) => {
      await recordDrop(path, KEY, SLUG, 3, "expired", T1);
      await chmod(spoolDropsPath(path, KEY, SLUG), 0o000);
    }],
    ["a .drops name that is a directory", async (path: string) => {
      await ensureDir(spoolDropsPath(path, KEY, SLUG));
    }],
    ["an unrecorded marker that will not parse", async (path: string) => {
      await ensureDir(spoolDir(path, KEY));
      await writePrivateFile(spoolUnrecordedDropsPath(path, KEY), '{"count":\n');
    }],
    ["a capture-loss ledger that is a directory", async (path: string) => {
      await ensureDir(lossLedgerPath(path));
    }],
  ] as const)("%s reads as at least one loss", async (_label, arrange) => {
    // Arrange
    const path = await home();
    await arrange(path);

    // Act
    const local = await readLocalLosses(path, KEY);
    await chmod(spoolDropsPath(path, KEY, SLUG), 0o644).catch(() => undefined);

    // Assert: unknown is never zero (§2), and a line says so (H3)
    expect(local.report.total).toBeGreaterThanOrEqual(1);
    const lines = formatLossLines(local, T4);
    expect([lines.dropped, lines.ignored, lines.capture].some((line) => line !== null)).toBe(true);
  });

  test("a spool directory nobody may list reads as at least one loss", async () => {
    // Arrange: 0o311 — files inside can be looked up, the directory cannot
    // be listed, so the ledgers in it are hidden while the archive and the
    // marker still read as plainly absent
    const path = await home();
    await recordDrop(path, KEY, SLUG, 3, "expired", T1);
    await chmod(spoolDir(path, KEY), 0o311);

    // Act
    const local = await readLocalLosses(path, KEY).finally(() => chmod(spoolDir(path, KEY), 0o755));

    // Assert
    expect(local.report.total).toBeGreaterThanOrEqual(1);
  });
});

describe("review C1/M2, connector half: the report always parses on the hub's schema", () => {
  test("PROBE 6: a ledger count past int4 is sent saturated, never as a report the hub refuses", async () => {
    // Arrange
    const path = await home();
    await ensureDir(spoolDir(path, KEY));
    await writeFile(
      spoolDropsPath(path, KEY, SLUG),
      `${JSON.stringify({ at: T4.toISOString(), count: 3_000_000_000, reason: "expired" })}\n`,
      "utf8",
    );

    // Act
    const { report } = await readLocalLosses(path, KEY);

    // Assert: saturated, still a loss, and valid on the wire
    expect(report.total).toBe(MAX_LOSS_COUNT);
    expect(report.kinds["spool_expired"]).toBe(MAX_LOSS_COUNT);
    expect(TelemetryLossReportSchema.safeParse(report).success).toBe(true);
  });

  test("an instant past year 9999 is undated, never a string the hub's schema refuses", async () => {
    // Arrange: Date.parse reads it; z.iso.datetime does not
    const path = await home();
    await recordDrop(path, KEY, SLUG, 3, "expired", T1);
    await ensureDir(join(path, "state"));
    await writeFile(
      lossLedgerPath(path),
      `${JSON.stringify({ at: "+275760-09-13T00:00:00.000Z", kind: "hook_timed_out", count: 1, key: KEY, detail: "stop" })}\n`,
    );

    // Act
    const { report } = await readLocalLosses(path, KEY);

    // Assert: read as undated — the kinds survive; the wire fallback did not fire
    expect(report.total).toBe(4);
    expect(report.kinds).toEqual({ spool_expired: 3, hook_timed_out: 1 });
    expect(TelemetryLossReportSchema.safeParse(report).success).toBe(true);
  });

  test("a report that still fails the wire schema is sent as a loss with no span", () => {
    // Arrange: more kinds than the hub admits — the last line of defence
    const kinds = Object.fromEntries(Array.from({ length: 30 }, (_unused, index) => [`k${String(index)}`, 1]));

    // Act
    const wire = toWireReport({ total: 30, kinds, oldestAt: T0.toISOString(), newestAt: T4.toISOString() });

    // Assert: never zero, never a refused session call
    expect(wire).toEqual({ total: 30, kinds: { unattributed: 30 }, oldestAt: null, newestAt: null });
    expect(TelemetryLossReportSchema.safeParse(wire).success).toBe(true);
  });
});

describe("one spelling for doctor and status", () => {
  test("the lines name counts, reasons and record kinds — and no path", async () => {
    // Arrange
    const path = await home();
    await recordDrop(path, KEY, SLUG, 3, "expired", T1);
    await recordDrop(path, KEY, SLUG, 2, "ignored", T2, { claim_revalidation: 2 });
    await recordCaptureLoss(path, { kind: "hook_timed_out", count: 1, key: KEY, detail: "post-tool-use", now: T4 });
    await recordCaptureLoss(path, { kind: "host_contract_drift", count: 2, key: KEY, detail: "afterFileEdit", now: T4 });

    // Act
    const lines = formatLossLines(await readLocalLosses(path, KEY), T4);

    // Assert
    expect(lines.dropped).toBe("5 records discarded in 2 batches (expired 3, ignored 2)");
    expect(lines.ignored).toContain("2 records in 1 batch ignored by the hub (claim_revalidation 2)");
    expect(lines.ignored).toContain("upgrade the hub");
    expect(lines.capture).toContain("1 hook exceeded its budget before capture could finish (post-tool-use 1)");
    expect(lines.capture).toContain("2 host payloads lacked a field capture needs");
    expect(`${lines.dropped ?? ""}${lines.ignored ?? ""}${lines.capture ?? ""}`).not.toContain("/");
  });

  test("a reason word or marker a hand edit planted prints as the ledger's own vocabulary, never as the string", async () => {
    // Arrange: a .drops line and a marker whose words are not the ledger's
    const path = await home();
    await ensureDir(spoolDir(path, KEY));
    await writeFile(
      spoolDropsPath(path, KEY, SLUG),
      `${JSON.stringify({ at: T1.toISOString(), count: 2, reason: "\u001b[31mrm -rf" })}\n`,
      "utf8",
    );
    await writePrivateFile(
      spoolUnrecordedDropsPath(path, KEY),
      `${JSON.stringify({ at: "\u001b]0;pwned\u0007", count: 4, reason: "\u001b[2J" })}\n`,
    );

    // Act
    const { dropped } = formatLossLines(await readLocalLosses(path, KEY), T4);

    // Assert
    expect(dropped).toContain("(other 2)");
    expect(dropped).toContain("(4 records, other, undated)");
    expect(dropped).not.toContain("\u001b");
  });

  test("a record kind outside the connector's vocabulary is kept as other, in the ledger and on the line", async () => {
    // Arrange
    const path = await home();

    // Act
    await recordDrop(path, KEY, SLUG, 2, "ignored", T1, { "Bad\u001b[31mKind": 2 });
    const { ignored } = formatLossLines(await readLocalLosses(path, KEY), T4);

    // Assert
    const ledger = await Bun.file(spoolDropsPath(path, KEY, SLUG)).text();
    expect(ledger).toContain('"kinds":{"other":2}');
    expect(ignored).toContain("(other 2)");
  });

  test("a prototype member's name as a reason is no reason: unattributed on the wire, other on the line", async () => {
    // Arrange
    const path = await home();
    await recordDrop(path, KEY, SLUG, 2, "constructor" as never, T1);
    await recordDrop(path, KEY, SLUG, 1, "__proto__" as never, T1);

    // Act
    const local = await readLocalLosses(path, KEY);

    // Assert
    expect(local.report.kinds).toEqual({ unattributed: 3 });
    expect(formatLossLines(local, T4).dropped).toContain("(other 3)");
  });

  test.each([
    ["one torn capture-ledger line (the H2 state)", async (path: string) => {
      await ensureDir(join(path, "state"));
      await writeFile(lossLedgerPath(path), "garbage\n", "utf8");
    }],
    ["a loss the full ledger refused (the H1 state)", async (path: string) => {
      await ensureDir(join(path, "state"));
      const other = `${JSON.stringify({ at: T0.toISOString(), kind: "hook_timed_out", count: 1, key: "another-repo", detail: "stop" })}\n`;
      await writeFile(lossLedgerPath(path), other.repeat(Math.ceil(MAX_LOSS_LEDGER_BYTES / other.length)), "utf8");
      await recordHookTimeout(path, "post-tool-use", KEY, T4);
    }],
    ["one torn .drops line", async (path: string) => {
      await ensureDir(spoolDir(path, KEY));
      await writeFile(spoolDropsPath(path, KEY, SLUG), '{"at":"2026\n', "utf8");
    }],
    ["an unrecorded marker alone", async (path: string) => {
      await ensureDir(spoolDir(path, KEY));
      await writePrivateFile(spoolUnrecordedDropsPath(path, KEY), `${JSON.stringify({ at: T4.toISOString(), count: 2, reason: "cap" })}\n`);
    }],
  ] as const)("H3: %s — a report above zero is never a 'none' on every line", async (_label, arrange) => {
    // Arrange
    const path = await home();
    await arrange(path);

    // Act
    const local = await readLocalLosses(path, KEY);
    const lines = formatLossLines(local, T4);

    // Assert: doctor and status cannot pass all three while the hub is told of a loss
    expect(local.report.total).toBeGreaterThan(0);
    expect([lines.dropped, lines.ignored, lines.capture].some((line) => line !== null)).toBe(true);
  });

  test("H3: a full capture ledger says since when, how many it refused, and when it can be removed", async () => {
    // Arrange
    const path = await home();
    await ensureDir(join(path, "state"));
    const other = `${JSON.stringify({ at: T0.toISOString(), kind: "hook_timed_out", count: 1, key: "another-repo", detail: "stop" })}\n`;
    await writeFile(lossLedgerPath(path), other.repeat(Math.ceil(MAX_LOSS_LEDGER_BYTES / other.length)), "utf8");
    await recordHookTimeout(path, "post-tool-use", KEY, T4);

    // Act
    const { capture } = formatLossLines(await readLocalLosses(path, KEY), T4);

    // Assert
    expect(capture).toContain("1 loss refused past its cap");
    expect(capture).toContain(`the newest at ${T4.toISOString().slice(0, 16)}Z`);
    expect(capture).toContain("the file can be removed once 14 days have passed since its last write");
  });

  test("H3: unreadable capture-ledger lines are named, counted one loss each", async () => {
    // Arrange
    const path = await home();
    await ensureDir(join(path, "state"));
    await writeFile(lossLedgerPath(path), "garbage\nmore garbage\n", "utf8");

    // Act
    const { capture } = formatLossLines(await readLocalLosses(path, KEY), T4);

    // Assert
    expect(capture).toContain("2 capture-ledger lines unreadable, counted as one loss each");
  });

  test("a clean machine prints nothing on any of the three", async () => {
    // Act
    const lines = formatLossLines(await readLocalLosses(await home(), KEY), T4);

    // Assert
    expect(lines).toEqual({ dropped: null, rejected: null, withheld: null, ignored: null, ignoredEarlier: null, capture: null });
  });
});

describe("hasRecentLoss mirrors the hub's window", () => {
  test("a loss newer than the window is recent; an older one, or none, is not", () => {
    // Arrange
    const now = new Date("2026-09-30T10:00:00.000Z");
    const recent = { ...EMPTY_LOSS_REPORT, total: 1, newestAt: new Date(now.getTime() - DAY_MS).toISOString() };
    const stale = {
      ...EMPTY_LOSS_REPORT,
      total: 1,
      newestAt: new Date(now.getTime() - (HUB_COVERAGE_WINDOW_DAYS + 1) * DAY_MS).toISOString(),
    };

    // Act & Assert
    expect(hasRecentLoss(recent, now)).toBe(true);
    expect(hasRecentLoss(stale, now)).toBe(false);
    expect(hasRecentLoss(EMPTY_LOSS_REPORT, now)).toBe(false);
  });
});
