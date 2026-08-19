/**
 * The drift ledger's own mechanics (src/drift.ts): append + read round-trip,
 * malformed lines counted instead of skipped, and the size cap that turns
 * the count into an honest floor instead of an unbounded disk.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { MAX_DRIFT_LEDGER_BYTES } from "../src/constants.ts";
import {
  driftLedgerPath,
  readContractDrift,
  recordContractDrift,
} from "../src/drift.ts";
import { makeHome } from "../../connector-core/test/helpers.ts";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })));
  homes.length = 0;
});

const home = async (label: string): Promise<string> => {
  const path = await makeHome(label);
  homes.push(path);
  return path;
};

describe("ledger round-trip", () => {
  test("records accumulate per event.field with the newest timestamp", async () => {
    // Arrange
    const h = await home("roundtrip");

    // Act
    await recordContractDrift(h, "afterFileEdit", ["file_path"]);
    await recordContractDrift(h, "afterFileEdit", ["file_path"]);
    await recordContractDrift(h, "stop", ["conversation_id"]);

    // Assert
    const drift = await readContractDrift(h);
    expect(drift.total).toBe(3);
    expect(drift.byField["afterFileEdit.file_path"]).toBe(2);
    expect(drift.byField["stop.conversation_id"]).toBe(1);
    expect(drift.lastAt).not.toBeNull();
    expect(drift.malformed).toBe(0);
    expect(drift.atCap).toBe(false);
  });

  test("an empty home reads as the empty summary", async () => {
    const drift = await readContractDrift(await home("empty"));
    expect(drift.total).toBe(0);
    expect(drift.lastAt).toBeNull();
  });

  test("a malformed line is counted, never silently skipped", async () => {
    // Arrange
    const h = await home("malformed");
    await recordContractDrift(h, "stop", ["conversation_id"]);
    const path = driftLedgerPath(h);
    await writeFile(path, `${await Bun.file(path).text()}not json\n`, "utf8");

    // Act
    const drift = await readContractDrift(h);

    // Assert
    expect(drift.total).toBe(1);
    expect(drift.malformed).toBe(1);
  });
});

describe("the cap makes counts a floor, not a lie", () => {
  test("a ledger at the cap refuses further detail and says so", async () => {
    // Arrange: a ledger already past the cap.
    const h = await home("cap");
    const path = driftLedgerPath(h);
    await mkdir(dirname(path), { recursive: true });
    const line = `${JSON.stringify({ at: "2026-08-19T00:00:00.000Z", event: "stop", missing: ["conversation_id"] })}\n`;
    const fill = line.repeat(Math.ceil(MAX_DRIFT_LEDGER_BYTES / line.length));
    await writeFile(path, fill, "utf8");
    const sizeBefore = (await Bun.file(path).text()).length;

    // Act
    await recordContractDrift(h, "afterFileEdit", ["file_path"]);

    // Assert: no growth, and the summary names the floor.
    expect((await Bun.file(path).text()).length).toBe(sizeBefore);
    const drift = await readContractDrift(h);
    expect(drift.atCap).toBe(true);
    expect(drift.byField["afterFileEdit.file_path"]).toBeUndefined();
  });
});
