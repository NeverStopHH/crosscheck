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
  NORMALIZED_DOC_MAX_TARGETS,
  buildNormalizedDoc,
} from "../src/services/normalized-doc.ts";
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

  test("the doc folds in at most NORMALIZED_DOC_MAX_TARGETS target values", async () => {
    // Arrange: tier-0 capture records a file target per touched file, and a
    // long monorepo session accumulates thousands — the doc query runs inside
    // every ingest transaction and must stay bounded. First-in-sort-order
    // wins, deterministically.
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(
      harness,
      developer,
      recordEnvelope("work_context", validWorkContextBody()),
    );
    const targetCount = NORMALIZED_DOC_MAX_TARGETS + 20;
    const valueAt = (index: number): string =>
      `src/pkg/${String(index).padStart(4, "0")}.ts`;
    const BATCH = 50;
    for (let start = 0; start < targetCount; start += BATCH) {
      const records = Array.from(
        { length: Math.min(BATCH, targetCount - start) },
        (_, offset) =>
          recordEnvelope("target", {
            workContextId: WORK_CONTEXT_ID,
            kind: "file",
            value: valueAt(start + offset),
          }),
      );
      await postRecords(harness, developer, { records });
    }

    // Act
    const doc = await readNormalizedDoc(harness);

    // Assert: exactly the cap, from the front of the sort order
    const includedCount = Array.from({ length: targetCount }, (_, index) =>
      valueAt(index),
    ).filter((value) => doc?.includes(value) === true).length;
    expect(includedCount).toBe(NORMALIZED_DOC_MAX_TARGETS);
    expect(doc).toContain(valueAt(0));
    expect(doc).not.toContain(valueAt(targetCount - 1));
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

describe("intent in the normalized doc (trial finding #16)", () => {
  test("an intent update regenerates the doc with the intent's sentence", async () => {
    // Arrange
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(harness, developer, recordEnvelope("work_context", validWorkContextBody()));

    // Act: the derived-intent worker's update record
    await postRecords(
      harness,
      developer,
      recordEnvelope(
        "work_context",
        validWorkContextBody({
          intent: {
            summary: "Make the tenant quota limiter refetch its budget",
            provenance: "derived",
            confidence: 0.4,
            capturedAt: "2026-07-24T09:02:00.000Z",
          },
        }),
      ),
    );

    // Assert: indexed like the title — the FTS tier sees it
    const doc = await readNormalizedDoc(harness);
    expect(doc).toContain("Login 500s on staging");
    expect(doc).toContain("Make the tenant quota limiter refetch its budget");
  });

  test("buildNormalizedDoc folds the intent summary right after the status", () => {
    // The whole document, byte for byte — including where the derived token
    // line sits (audit row M12-rest): after the description and BEFORE the
    // target values, because NORMALIZED_DOC_MAX_CHARS cuts from the end.
    expect(
      buildNormalizedDoc({
        title: "T",
        status: "analyzing",
        intentSummary: "I",
        description: null,
        targetValues: ["src/auth/refresh.ts"],
        claimSummaries: ["observation: O"],
        repoLabel: null,
      }),
    ).toBe(
      "T\nanalyzing\nI\nauth refresh\nsrc/auth/refresh.ts\nobservation: O",
    );
  });
});
