/**
 * THE START-UP UPGRADE PASSES RUN APART (review round 4, L3;
 * services/startup-upgrades.ts). They used to be one promise chain: a
 * cleanup that threw skipped the doc upgrade, and one error line covered
 * every step. Now each pass runs whatever the one before it did, and each
 * logs its own outcome — and its own error.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { runStartupUpgrades } from "../src/services/startup-upgrades.ts";
import type { StartupLog } from "../src/services/startup-upgrades.ts";
import { createFakeEmbedder } from "./fixtures/fake-embedder.ts";
import { inMemoryUpgradeHub, seedPreRoundContexts } from "./fixtures/upgrade-hub.ts";

interface CapturedLog {
  readonly log: StartupLog;
  readonly infos: string[];
  readonly errors: string[];
}

const capture = (): CapturedLog => {
  const infos: string[] = [];
  const errors: string[] = [];
  return {
    log: { info: (line) => infos.push(line), error: (line) => errors.push(line) },
    infos,
    errors,
  };
};

describe("runStartupUpgrades", () => {
  test("runs the link cleanup, the doc upgrade and — with an embedder — the vector backfill, each logging its own line", async () => {
    // Arrange
    const { harness } = await inMemoryUpgradeHub();
    await seedPreRoundContexts(harness.db, 2);
    const captured = capture();

    // Act
    const report = await runStartupUpgrades({ db: harness.db, embedder: createFakeEmbedder(), log: captured.log });

    // Assert
    expect(report.links?.removed).toEqual([]);
    expect(report.docs).toMatchObject({ contexts: 2, reembedded: 2 });
    expect(report.vectors).toEqual({ embedded: 0, failed: 0 });
    expect(captured.infos.map((line) => line.split(":")[0])).toEqual([
      "[crosscheck] draft link cleanup",
      "[crosscheck] doc upgrade",
      "[crosscheck] vector backfill",
    ]);
    expect(captured.errors).toEqual([]);
  });

  test("a cleanup that fails never keeps the doc upgrade from running, and logs its own error", async () => {
    // Arrange: the archive the cleanup writes to is gone
    const { harness } = await inMemoryUpgradeHub();
    await seedPreRoundContexts(harness.db, 2);
    await harness.db.execute(sql`DROP TABLE claim_edges_removed`);
    const captured = capture();

    // Act
    const report = await runStartupUpgrades({ db: harness.db, embedder: null, log: captured.log });

    // Assert
    expect(report.links).toBeNull();
    expect(report.docs?.contexts).toBe(2);
    expect(captured.errors).toEqual(["[crosscheck] draft link cleanup failed; the next start retries it"]);
    expect(captured.infos.map((line) => line.split(":")[0])).toEqual(["[crosscheck] doc upgrade"]);
  });

  test("a doc upgrade that fails never keeps the vector backfill from running", async () => {
    // Arrange: the doc upgrade's progress column is gone; the docs are not
    const { harness } = await inMemoryUpgradeHub();
    await seedPreRoundContexts(harness.db, 2);
    await harness.db.execute(sql`ALTER TABLE work_contexts DROP COLUMN doc_version`);
    const captured = capture();

    // Act
    const report = await runStartupUpgrades({ db: harness.db, embedder: createFakeEmbedder(), log: captured.log });

    // Assert
    expect(report.docs).toBeNull();
    expect(report.vectors).toEqual({ embedded: 2, failed: 0 });
    expect(captured.errors).toEqual(["[crosscheck] doc upgrade failed; the next start resumes it"]);
  });

  test("without an embedder there is no vector backfill", async () => {
    const { harness } = await inMemoryUpgradeHub();
    const captured = capture();

    const report = await runStartupUpgrades({ db: harness.db, embedder: null, log: captured.log });

    expect(report.vectors).toBeNull();
    expect(captured.infos.some((line) => line.startsWith("[crosscheck] vector backfill"))).toBe(false);
  });
});
