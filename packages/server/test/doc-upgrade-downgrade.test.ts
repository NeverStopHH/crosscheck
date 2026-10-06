/**
 * WHY A DOWNGRADE IS UNSUPPORTED, AND THE DOCUMENTED WAY BACK (review round
 * 4, L1; docs/OPERATIONS.md "Downgrading is not supported").
 *
 * The review's downgrade probe ran upgrade → v0.10.0 → upgrade on one data
 * dir. v0.10.0 does not know work_contexts.doc_version: a draft it ingests is
 * folded into the doc, and the row stays stamped current — so the next start
 * of this version skips it, and the draft's word stays searchable for good.
 * Here the older version's write is emulated in SQL; the recovery is the
 * statement the ops page gives, run exactly as written there.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { upgradeNormalizedDocs } from "../src/services/doc-upgrade.ts";
import { NORMALIZED_DOC_VERSION } from "../src/services/normalized-doc.ts";
import { documentedSql } from "./fixtures/operations-doc.ts";
import { inMemoryUpgradeHub, seedPreRoundContexts } from "./fixtures/upgrade-hub.ts";
import type { UpgradeHub } from "./fixtures/upgrade-hub.ts";
import { VALID_SESSION_BODY } from "./helpers.ts";

const DOWNGRADE_WORD = "downgradedraftword";

/** An upgraded hub, then the older version ingests a draft into wc_000001. */
const downgradedOnce = async (): Promise<UpgradeHub> => {
  const hub = await inMemoryUpgradeHub();
  await seedPreRoundContexts(hub.harness.db, 1);
  await upgradeNormalizedDocs({ db: hub.harness.db, embedder: null });
  await hub.harness.db.execute(sql`
    INSERT INTO claims (id, work_context_id, author_session_id, kind, body, status, confidence, capture_mode, provenance, created_at)
    VALUES ('clm_d2', 'wc_000001', ${VALID_SESSION_BODY.id}, 'hypothesis', ${`${DOWNGRADE_WORD} guess`}, 'proposed', 0.4, 'auto', 'derived', now())`);
  await hub.harness.db.execute(
    sql`UPDATE work_contexts SET normalized_doc = normalized_doc || ${`\nhypothesis: ${DOWNGRADE_WORD} guess`} WHERE id = 'wc_000001'`,
  );
  return hub;
};

const doc = async (hub: UpgradeHub) =>
  (await hub.harness.db.execute(sql`SELECT normalized_doc, doc_version FROM work_contexts WHERE id = 'wc_000001'`)).rows[0] as {
    readonly normalized_doc: string;
    readonly doc_version: number;
  };

describe("a hub an older version ran on after the upgrade", () => {
  test("the next start takes the older version's doc for a current one, and leaves the draft's word in it", async () => {
    // Arrange
    const hub = await downgradedOnce();

    // Act: this version starts again
    const report = await upgradeNormalizedDocs({ db: hub.harness.db, embedder: null });

    // Assert: the hazard the ops page names
    expect(report.contexts).toBe(0);
    expect((await doc(hub)).normalized_doc).toContain(DOWNGRADE_WORD);
  });

  test("the documented recovery rebuilds it on the next start", async () => {
    // Arrange
    const hub = await downgradedOnce();

    // Act: the operator runs the ops page's statement, then this version starts
    await hub.harness.db.execute(sql.raw(await documentedSql("after-a-downgrade")));
    const report = await upgradeNormalizedDocs({ db: hub.harness.db, embedder: null });

    // Assert
    expect(report.contexts).toBe(1);
    expect(await doc(hub)).toMatchObject({ doc_version: NORMALIZED_DOC_VERSION });
    expect((await doc(hub)).normalized_doc).not.toContain(DOWNGRADE_WORD);
  });
});
