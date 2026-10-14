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
  test("runs the link cleanup, the location index, the doc upgrade, the words index and — with an embedder — the vector backfill, each logging its own line", async () => {
    // Arrange
    const { harness } = await inMemoryUpgradeHub();
    await seedPreRoundContexts(harness.db, 2);
    const captured = capture();

    // Act
    const report = await runStartupUpgrades({ db: harness.db, embedder: createFakeEmbedder(), log: captured.log });

    // Assert
    expect(report.links?.removed).toEqual([]);
    expect(report.locations).toBe(0);
    expect(report.docs).toMatchObject({ contexts: 2, reembedded: 2 });
    expect(report.words).toEqual({ claims: 0, workContexts: 0 });
    expect(report.vectors).toEqual({ embedded: 0, failed: 0 });
    const expectedStarts = [
      "[crosscheck] draft link cleanup: 0 cross-developer draft link(s) archived in claim_edges_removed and removed (pass dlc_",
      "[crosscheck] location index: rebuilt for 0 opted-out developer(s)",
      "[crosscheck] doc upgrade: starting: 2 work context doc(s) still fold drafts in",
      "[crosscheck] doc upgrade: 2 work context doc(s) rebuilt without drafts, 0 stamped current, 2 re-embedded",
      "[crosscheck] words index: 0 claim(s) and 0 work context(s) given their dotted names' parts",
      "[crosscheck] vector backfill: 0 work context(s) embedded, 0 failed",
    ];
    expect(captured.infos.map((line, index) => line.startsWith(expectedStarts[index] ?? "\0"))).toEqual(
      expectedStarts.map(() => true),
    );
    expect(captured.errors).toEqual([]);
  });

  test("a cleanup that fails never keeps the doc upgrade from running, and logs its own error", async () => {
    // Arrange: the column the cleanup selects the gate's edges by is gone
    // (the cleanup is paged and writes its archive only for a page it found,
    // so a missing archive no longer fails a hub with nothing to clean)
    const { harness } = await inMemoryUpgradeHub();
    await seedPreRoundContexts(harness.db, 2);
    await harness.db.execute(sql`ALTER TABLE claim_edges DROP COLUMN origin`);
    const captured = capture();

    // Act
    const report = await runStartupUpgrades({ db: harness.db, embedder: null, log: captured.log });

    // Assert
    expect(report.links).toBeNull();
    expect(report.docs?.contexts).toBe(2);
    expect(captured.errors).toEqual(["[crosscheck] draft link cleanup failed; the next start retries it"]);
    expect(captured.infos.map((line) => line.split(":")[0])).toEqual([
      "[crosscheck] location index",
      "[crosscheck] doc upgrade",
      "[crosscheck] doc upgrade",
      "[crosscheck] words index",
    ]);
  });

  test("fills the words an upgrade left empty, and gives an opted-out index its rebuild (M10, M11)", async () => {
    // Arrange — declared-only contexts (the doc upgrade only stamps them),
    // every row's words still empty, and a developer opted out before the
    // index followed the setting
    const { harness, nick } = await inMemoryUpgradeHub();
    await seedPreRoundContexts(harness.db, 2, { withDraft: false });
    await harness.db.execute(sql`UPDATE claims SET words_tsv = NULL`);
    await harness.db.execute(sql`UPDATE work_contexts SET words_tsv = NULL`);
    await harness.db.execute(sql`UPDATE developers SET presence_opt_out = true WHERE id = ${nick.developerId}`);
    const captured = capture();

    // Act
    const report = await runStartupUpgrades({ db: harness.db, embedder: null, log: captured.log });

    // Assert
    expect(report.locations).toBe(1);
    expect(report.words).toEqual({ claims: 2, workContexts: 0 });
    expect(captured.infos).toContain("[crosscheck] words index: 2 claim(s) and 0 work context(s) given their dotted names' parts");
    expect(captured.errors).toEqual([]);
  });

  test("a words backfill that fails never keeps the vector backfill from running", async () => {
    // Arrange: the function the backfill fills by is gone
    const { harness } = await inMemoryUpgradeHub();
    await seedPreRoundContexts(harness.db, 2);
    await harness.db.execute(sql`UPDATE claims SET words_tsv = NULL`);
    await harness.db.execute(sql`DROP TRIGGER claims_words_tsv_fill ON claims`);
    await harness.db.execute(sql`DROP TRIGGER work_contexts_words_tsv_fill ON work_contexts`);
    await harness.db.execute(sql`DROP FUNCTION crosscheck_claims_words_tsv()`);
    await harness.db.execute(sql`DROP FUNCTION crosscheck_work_contexts_words_tsv()`);
    await harness.db.execute(sql`DROP FUNCTION crosscheck_words_tsv(text)`);
    const captured = capture();

    // Act
    const report = await runStartupUpgrades({ db: harness.db, embedder: createFakeEmbedder(), log: captured.log });

    // Assert
    expect(report.words).toBeNull();
    expect(report.vectors).not.toBeNull();
    expect(captured.errors).toEqual(["[crosscheck] words index failed; the next start resumes it"]);
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
