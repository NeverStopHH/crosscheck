/**
 * The searchable form of a work context (DESIGN.md §6).
 *
 * FTS runs over this doc, not over the raw records: title + status + target
 * values + claim-kind summaries. "Never raw transcript" is enforced upstream —
 * transcripts never reach the hub (DESIGN.md §3) — so everything folded in
 * here is already structured, capped, team-visible data.
 *
 * Regenerated on every ingest that changes what the doc is built from
 * (work-context create/update, target, claim). The tsv GENERATED column in
 * bootstrap.sql re-derives automatically, which is why this module only ever
 * writes normalized_doc.
 *
 * Regeneration also CLEARS the context embedding: a vector minted from the old
 * doc no longer describes the new one, and a null embedding merely drops the
 * row from the optional vector tier — exact and FTS still list it. The ingest
 * path that has an embedder re-embeds afterwards (record-handlers.ts).
 */
import { and, asc, desc, eq } from "drizzle-orm";

import { claims, workContextTargets, workContexts } from "../db/schema.ts";
import type { DbExecutor } from "../db/client.ts";
import type { Embedder } from "./embedder.ts";

/**
 * Newest claims folded into the doc; older ones age out of the summary.
 * Matches the shape of what a briefing needs — recent thinking, not history.
 */
export const NORMALIZED_DOC_MAX_CLAIMS = 50;

/**
 * Hard cap on the stored doc so the tsv it generates stays bounded. Roughly
 * MAX_CLAIM_BODY_LENGTH × 20 claims of prose — far more than ranking needs.
 */
export const NORMALIZED_DOC_MAX_CHARS = 8000;

export interface NormalizedDocInput {
  readonly title: string;
  readonly status: string;
  readonly description: string | null;
  readonly targetValues: readonly string[];
  /** One line per claim, already in "kind: body" form. */
  readonly claimSummaries: readonly string[];
}

/** Pure builder — the single place that decides what the doc contains. */
export const buildNormalizedDoc = (input: NormalizedDocInput): string =>
  [
    input.title,
    input.status,
    input.description ?? "",
    ...input.targetValues,
    ...input.claimSummaries,
  ]
    .filter((part) => part.length > 0)
    .join("\n")
    .slice(0, NORMALIZED_DOC_MAX_CHARS);

/**
 * Rebuilds and stores the doc for one work context from current rows.
 *
 * A no-op for an unknown id rather than an error: callers run inside ingest,
 * where the context's existence was already checked, and a race with nothing
 * to refresh must not fail the record that won.
 */
export const refreshNormalizedDoc = async (
  db: DbExecutor,
  workContextId: string,
): Promise<void> => {
  const contextRows = await db
    .select({
      title: workContexts.title,
      status: workContexts.status,
      description: workContexts.description,
    })
    .from(workContexts)
    .where(eq(workContexts.id, workContextId))
    .limit(1);
  const context = contextRows[0];
  if (context === undefined) {
    return;
  }

  const targetRows = await db
    .select({ value: workContextTargets.value })
    .from(workContextTargets)
    .where(eq(workContextTargets.workContextId, workContextId))
    .orderBy(asc(workContextTargets.value));
  const claimRows = await db
    .select({ kind: claims.kind, body: claims.body })
    .from(claims)
    .where(eq(claims.workContextId, workContextId))
    .orderBy(desc(claims.createdAt))
    .limit(NORMALIZED_DOC_MAX_CLAIMS);

  const doc = buildNormalizedDoc({
    title: context.title,
    status: context.status,
    description: context.description,
    targetValues: targetRows.map((row) => row.value),
    claimSummaries: claimRows.map((row) => `${row.kind}: ${row.body}`),
  });

  await db
    .update(workContexts)
    .set({ normalizedDoc: doc, embedding: null, embeddingModel: null })
    .where(eq(workContexts.id, workContextId));
};

/**
 * Embeds the CURRENT doc of a work context, feeding the vector search tier.
 *
 * Called OUTSIDE the ingest transaction — an external HTTP call must never
 * hold a transaction open, least of all on single-connection PGlite. That
 * makes a race possible: another ingest may change the doc while we embed the
 * old one. The WHERE clause closes it — the vector is stored only if the doc
 * it was minted from is still the doc on the row; a lost race leaves the
 * embedding null, and the next ingest re-embeds.
 *
 * Failure degrades, never propagates: the record this ran for is already
 * durable, and a missing vector only hides the row from the OPTIONAL tier.
 */
export const embedContextDoc = async (
  db: DbExecutor,
  embedder: Embedder,
  workContextId: string,
): Promise<void> => {
  const rows = await db
    .select({ normalizedDoc: workContexts.normalizedDoc })
    .from(workContexts)
    .where(eq(workContexts.id, workContextId))
    .limit(1);
  const doc = rows[0]?.normalizedDoc;
  if (doc === undefined || doc === null || doc.length === 0) {
    return;
  }
  try {
    const [vector] = await embedder.embed([doc]);
    if (vector === undefined) {
      return;
    }
    await db
      .update(workContexts)
      .set({ embedding: [...vector], embeddingModel: embedder.model })
      .where(
        and(
          eq(workContexts.id, workContextId),
          eq(workContexts.normalizedDoc, doc),
        ),
      );
  } catch (error) {
    console.error(
      `[crosscheck] embedding work context ${workContextId} failed; vector tier will miss it until the next ingest`,
      error,
    );
  }
};
