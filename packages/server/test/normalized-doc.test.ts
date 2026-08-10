/**
 * The searchable form of a work context (DESIGN.md §6).
 *
 * `normalized_doc` is what FTS runs over: title + status + target values +
 * claim-kind summaries — never a raw transcript, because raw transcripts never
 * reach the hub in the first place (DESIGN.md §3). It is a stored column,
 * regenerated hub-side on work-context, target and claim ingest, so the tsv
 * generated column on top of it re-derives automatically.
 *
 * The last two tests are the PGlite capability proof the search block rests on:
 * a GENERATED tsvector column with a GIN index, queried through
 * websearch_to_tsquery, inside the embedded database the default install uses.
 */
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { workContexts } from "../src/db/schema.ts";
import {
  createHarnessWithSession,
  postRecords,
  recordEnvelope,
  validClaimBody,
  validWorkContextBody,
  WORK_CONTEXT_ID,
} from "./helpers.ts";
import type { TestHarness } from "./helpers.ts";

const readNormalizedDoc = async (
  harness: TestHarness,
): Promise<string | null> => {
  const rows = await harness.db
    .select({ normalizedDoc: workContexts.normalizedDoc })
    .from(workContexts)
    .where(eq(workContexts.id, WORK_CONTEXT_ID))
    .limit(1);
  return rows[0]?.normalizedDoc ?? null;
};

describe("normalized_doc generation on ingest", () => {
  test("work context ingest stores a doc carrying title and status", async () => {
    // Arrange
    const { harness, developer } = await createHarnessWithSession();

    // Act
    await postRecords(
      harness,
      developer,
      recordEnvelope("work_context", validWorkContextBody()),
    );

    // Assert
    const doc = await readNormalizedDoc(harness);
    expect(doc).toContain("Login 500s on staging");
    expect(doc).toContain("analyzing");
  });

  test("target ingest regenerates the doc with the target value", async () => {
    // Arrange
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(
      harness,
      developer,
      recordEnvelope("work_context", validWorkContextBody()),
    );

    // Act
    await postRecords(
      harness,
      developer,
      recordEnvelope("target", {
        workContextId: WORK_CONTEXT_ID,
        kind: "file",
        value: "src/auth/jwt.ts",
      }),
    );

    // Assert
    const doc = await readNormalizedDoc(harness);
    expect(doc).toContain("src/auth/jwt.ts");
  });

  test("claim ingest regenerates the doc with kind and body", async () => {
    // Arrange
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(
      harness,
      developer,
      recordEnvelope("work_context", validWorkContextBody()),
    );

    // Act
    await postRecords(
      harness,
      developer,
      recordEnvelope(
        "claim",
        validClaimBody({
          kind: "hypothesis",
          body: "The refresh path reads a rotated signing key",
        }),
      ),
    );

    // Assert
    const doc = await readNormalizedDoc(harness);
    expect(doc).toContain("hypothesis");
    expect(doc).toContain("The refresh path reads a rotated signing key");
  });

  test("a work context update regenerates the doc under the new title", async () => {
    // Arrange
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(
      harness,
      developer,
      recordEnvelope("work_context", validWorkContextBody()),
    );

    // Act
    await postRecords(
      harness,
      developer,
      recordEnvelope(
        "work_context",
        validWorkContextBody({ title: "Login 500s trace to key rotation" }),
      ),
    );

    // Assert
    const doc = await readNormalizedDoc(harness);
    expect(doc).toContain("Login 500s trace to key rotation");
    expect(doc).not.toContain("Login 500s on staging");
  });
});

describe("FTS columns in the embedded database (PGlite capability proof)", () => {
  test("websearch_to_tsquery matches an ingested context through its tsv", async () => {
    // Arrange: the whole pipeline — ingest fills normalized_doc, the GENERATED
    // tsv column derives from it, websearch finds it. This is the §6 claim
    // "PGlite supports this" as a test rather than a hope.
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(harness, developer, {
      records: [
        recordEnvelope("work_context", validWorkContextBody()),
        recordEnvelope(
          "claim",
          validClaimBody({
            kind: "hypothesis",
            body: "The refresh path reads a rotated signing key",
          }),
        ),
      ],
    });

    // Act: match on a word that appears ONLY in a claim body, so the hit
    // proves the doc carries claim summaries rather than the title alone.
    const rows = await harness.db
      .select({ id: workContexts.id })
      .from(workContexts)
      .where(
        sql`${workContexts}.tsv @@ websearch_to_tsquery('english', ${"rotated signing"})`,
      );

    // Assert
    expect(rows.map((row) => row.id)).toContain(WORK_CONTEXT_ID);
  });

  test("GIN indexes exist on both tsv columns", async () => {
    // Arrange
    const { harness } = await createHarnessWithSession();

    // Act
    const rows = await harness.db.execute(
      sql`SELECT indexname FROM pg_indexes WHERE indexdef LIKE '%USING gin%'`,
    );
    const names = rows.rows.map((row) => String(row["indexname"]));

    // Assert
    expect(names).toContain("work_contexts_tsv_idx");
    expect(names).toContain("claims_tsv_idx");
  });
});
