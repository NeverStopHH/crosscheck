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

import { agentSessions, claims, workContextTargets, workContexts } from "../db/schema.ts";
import { derivedTokenLine, repoLabelOf, titleForDoc } from "./search-tokens.ts";
import type { DbExecutor } from "../db/client.ts";
import type { Embedder } from "./embedder.ts";

/**
 * Newest claims folded into the doc; older ones age out of the summary.
 * Matches the shape of what a briefing needs — recent thinking, not history.
 */
export const NORMALIZED_DOC_MAX_CLAIMS = 50;

/**
 * Target values folded into the doc, first in sort order. Tier-0 capture
 * records a file target per touched file, and a long monorepo session
 * accumulates thousands — this query runs inside every ingest transaction on
 * the single connection, so it is bounded like the claims query above.
 */
export const NORMALIZED_DOC_MAX_TARGETS = 100;

/**
 * Hard cap on the stored doc so the tsv it generates stays bounded — twenty
 * full-length claim bodies of prose, far more than ranking needs:
 *
 * VERIFY: bun -e 'const d=await import("./packages/server/src/services/normalized-doc.ts");const s=await import("./packages/schema/src/index.ts");console.log(d.NORMALIZED_DOC_MAX_CHARS, 20*s.MAX_CLAIM_BODY_LENGTH)'
 * PRINTS: 8000 8000
 */
export const NORMALIZED_DOC_MAX_CHARS = 8000;

export interface NormalizedDocInput {
  readonly title: string;
  readonly status: string;
  /**
   * The owning session's repo label (`github.com/acme/api` → `api`), or null
   * when there is none to take off — a `local:` id, or a caller that genuinely
   * does not know. REQUIRED rather than optional so the decision is made at
   * every call site: null means "nothing to strip", never "not sure"
   * (services/search-tokens.ts `titleForDoc` says what comes off and why).
   */
  readonly repoLabel: string | null;
  /**
   * The session's intent sentence (trial finding #16): indexed like the
   * title, so a teammate's prompt that shares only the TOPIC — no file, no
   * claim — still reaches the context through the FTS tier and becomes a
   * pointer. Null when no intent was ever captured.
   */
  readonly intentSummary: string | null;
  readonly description: string | null;
  readonly targetValues: readonly string[];
  /** One line per claim, already in "kind: body" form. */
  readonly claimSummaries: readonly string[];
}

/** The one field of the intent jsonb that is searchable prose. */
export const intentSummaryOf = (
  intent: Record<string, unknown> | null | undefined,
): string | null => {
  const summary = intent?.["summary"];
  return typeof summary === "string" && summary.length > 0 ? summary : null;
};

/**
 * Pure builder — the single place that decides what the doc contains.
 *
 * The DERIVED TOKEN LINE sits between the description and the target values,
 * and that position is the cap talking rather than taste: the slice below cuts
 * from the END, so anything behind the claim summaries would be the first
 * thing a claim-heavy context loses, and the token line is what makes a branch
 * name and a path findable AT ALL (audit row M12-rest). Its own bound keeps
 * the trade small — DERIVED_TOKENS_MAX_CHARS is 7.5 % of the doc cap.
 *
 * Claim summaries are NOT tokenized. They are prose, which the english
 * configuration already splits correctly, and a fifty-claim context would
 * spend the whole token bound on words that are in the document twice already.
 */
export const buildNormalizedDoc = (input: NormalizedDocInput): string => {
  const title = titleForDoc(input.title, input.repoLabel);
  return [
    title,
    input.status,
    input.intentSummary ?? "",
    input.description ?? "",
    derivedTokenLine([title, ...input.targetValues], input.repoLabel),
    ...input.targetValues,
    ...input.claimSummaries,
  ]
    .filter((part) => part.length > 0)
    .join("\n")
    .slice(0, NORMALIZED_DOC_MAX_CHARS);
};

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
      intent: workContexts.intent,
      description: workContexts.description,
      // The repo the owning session runs on — one more column of the row this
      // query already fetches, joined on the session's primary key, so the
      // label M13 strips costs no extra round trip.
      repo: agentSessions.repo,
    })
    .from(workContexts)
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
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
    .orderBy(asc(workContextTargets.value))
    .limit(NORMALIZED_DOC_MAX_TARGETS);
  const claimRows = await db
    .select({ kind: claims.kind, body: claims.body })
    .from(claims)
    .where(eq(claims.workContextId, workContextId))
    .orderBy(desc(claims.createdAt))
    .limit(NORMALIZED_DOC_MAX_CLAIMS);

  const doc = buildNormalizedDoc({
    title: context.title,
    status: context.status,
    repoLabel: repoLabelOf(context.repo),
    intentSummary: intentSummaryOf(context.intent),
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
