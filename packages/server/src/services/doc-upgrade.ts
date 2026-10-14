/**
 * THE UPGRADE PASS THAT TAKES DRAFTS BACK OUT OF THE DOCS (review round 3,
 * HIGH-1).
 *
 * Round 2 stopped folding unreviewed drafts and discards into a work
 * context's normalized doc (services/normalized-doc.ts, DECLARED claims only)
 * — for every doc built from then on. A hub upgraded across that change keeps
 * every doc it built before, and with them each draft's and each discard's
 * words in the FTS doc tier and in the embedding minted from that doc: a
 * teammate's search finds a discarded word as an ordinary match, never marked
 * draft-only, and keeps finding it for good on a tree nobody ingests into
 * again.
 *
 * WHAT IT REBUILDS: every work context whose doc predates
 * NORMALIZED_DOC_VERSION AND that holds a non-declared claim. A context with
 * declared claims only built the same doc under both rules, so rebuilding it
 * would only drop and re-mint its vector. The review asked for "a derived or
 * rejected claim": a discard's rejected copy is derived, so it is covered; a
 * DECLARED rejected claim folds in under both rules (a refuted theory stays
 * searchable), so it adds nothing to rebuild.
 *
 * PAGED, IDEMPOTENT, RESUMABLE. `refreshNormalizedDoc` stamps the version
 * with every doc it writes, so the version column IS the progress record: a
 * restart picks up exactly the contexts not yet rebuilt, and a finished hub
 * finds none. Within one run a page cursor on the id keeps the pass finite
 * even if a rebuild could not stamp its row. Each page is DOC_UPGRADE_BATCH
 * contexts.
 *
 * THE VECTOR. A rebuild clears the context's embedding — a vector of the old
 * doc no longer describes the new one — in the same UPDATE that stamps the
 * version. With an embedder the page is re-embedded in ONE call right after
 * its rebuild, and only vectors actually stored are counted. Whatever keeps
 * one from landing — the provider failing, no embedder on this start, a kill
 * between the rebuild and the embed — leaves the vector null with the doc
 * stamped current, so THIS pass will not revisit it: the every-start
 * backfill (services/embedding-backfill.ts) re-embeds any context without a
 * vector of the current model, and the loss heals on the next start that has
 * an embedder. (This comment once said the vector tier "misses a context
 * only between the two, never for good" — false until that backfill
 * existed; review round 4, H2.)
 *
 * Run AFTER the hub is serving (index.ts), in the background: until it has
 * run, an old doc only keeps matching as it did before the upgrade, so
 * nothing waits on it — and a large hub is not held offline while it runs.
 */
import { and, asc, gt, inArray, lt, not, sql } from "drizzle-orm";

import { DOC_UPGRADE_BATCH, DOC_UPGRADE_PROGRESS_PAGES, DOC_UPGRADE_STAMP_BATCH } from "../constants.ts";
import type { Db } from "../db/client.ts";
import { workContexts } from "../db/schema.ts";
import type { Embedder } from "./embedder.ts";
import { embedContextDocs } from "./embedding-backfill.ts";
import type { EmbedOutcome } from "./embedding-backfill.ts";
import { yieldToEventLoop } from "./event-loop.ts";
import { NORMALIZED_DOC_VERSION, refreshNormalizedDoc } from "./normalized-doc.ts";
import { BEFORE_EVERY_ID, countPendingDocs, holdsNonDeclaredClaim } from "./stale-docs.ts";

interface Deps {
  readonly db: Db;
  readonly embedder: Embedder | null;
}

export interface DocUpgradeReport {
  /** Contexts whose doc this run rebuilt. */
  readonly contexts: number;
  /** Declared-only contexts this run stamped current without a rebuild. */
  readonly stamped: number;
  /** Of the rebuilt, the ones whose new vector was minted and stored. */
  readonly reembedded: number;
  /** Of the rebuilt, the ones whose vector could not be minted (healed by the backfill). */
  readonly embedFailures: number;
}

/** One page of declared-only contexts after the cursor whose doc predates the current rule. */
const declaredOnlyPage = async (db: Db, after: string, batch: number): Promise<readonly string[]> => {
  const rows = await db
    .select({ id: workContexts.id })
    .from(workContexts)
    .where(
      and(
        gt(workContexts.id, after),
        lt(workContexts.docVersion, NORMALIZED_DOC_VERSION),
        not(holdsNonDeclaredClaim(db, after)),
      ),
    )
    .orderBy(asc(workContexts.id))
    .limit(batch);
  return rows.map((row) => row.id);
};

/**
 * DECLARED-ONLY CONTEXTS ARE STAMPED, NOT REBUILT (review round 4, L2): their
 * doc is the same under both rules, so the version is all that is wrong — and
 * left at 0 they were re-scanned by every start's first page (20 000 of them
 * on the review's 50 000-context probe).
 *
 * A PAGE AT A TIME, with a turn of the event loop between pages (round 5): as
 * one UPDATE, the 20 000 rows held every request for ~400 ms — past the
 * connector's 400 ms hook timeout. The cursor is the page's last id in the
 * database's own order, so each page starts where the last ended.
 */
const stampFrom = async (db: Db, batch: number, after: string, stamped: number): Promise<number> => {
  const ids = await declaredOnlyPage(db, after, batch);
  const last = ids[ids.length - 1];
  if (last === undefined) {
    return stamped;
  }
  await db
    .update(workContexts)
    .set({ docVersion: NORMALIZED_DOC_VERSION })
    .where(and(inArray(workContexts.id, [...ids]), lt(workContexts.docVersion, NORMALIZED_DOC_VERSION)));
  if (ids.length < batch) {
    return stamped + ids.length;
  }
  await yieldToEventLoop();
  return stampFrom(db, batch, last, stamped + ids.length);
};

/** One page of contexts still built under an older rule that hold a non-declared claim. */
const stalePage = async (db: Db, after: string, batch: number): Promise<readonly string[]> => {
  const rows = await db
    .select({ id: workContexts.id })
    .from(workContexts)
    .where(
      and(
        gt(workContexts.id, after),
        lt(workContexts.docVersion, NORMALIZED_DOC_VERSION),
        holdsNonDeclaredClaim(db, after),
      ),
    )
    .orderBy(asc(workContexts.id))
    .limit(batch);
  return rows.map((row) => row.id);
};

/**
 * ONE REBUILD, ONE TRANSACTION, THE ROW LOCKED (review round 4, M1). The
 * rebuild reads the context's claims, then writes its doc; outside a
 * transaction PGlite's FIFO let a queued ingest commit a vouched claim
 * between the two, and the pass's stale write landed on top of the ingest's
 * own rebuild — the context stamped current without the claim, for good. In
 * a transaction the ingest waits for the commit and rebuilds after it; on a
 * shared Postgres the FOR UPDATE row lock gives the same order against an
 * ingest on another connection.
 */
const rebuildLocked = (db: Db, id: string): Promise<void> =>
  db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM work_contexts WHERE id = ${id} FOR UPDATE`);
    await refreshNormalizedDoc(tx, id);
  });

const NO_EMBEDS: EmbedOutcome = { embedded: 0, failed: 0 };

/**
 * Rebuilds one page, one context at a time, then (with an embedder) embeds it
 * in one call.
 *
 * A TURN OF THE EVENT LOOP AFTER EVERY REBUILD, NOT EVERY PAGE (CI,
 * 2026-10-13). A request that arrives while the pass runs waits for the next
 * turn: with one per page that was the rest of the page, about 70 ms on a
 * laptop and 390 ms for 100 contexts on a slow macos-latest runner, where a
 * teammate's request waited 624 ms. One per rebuild bounds the wait by one
 * context's rebuild, and costs next to nothing: 30,000 turns took 22 ms on
 * my laptop, where the pass rebuilt 3,000 contexts in 3.5 s.
 */
const upgradePage = async (deps: Deps, ids: readonly string[]): Promise<EmbedOutcome> => {
  for (const id of ids) {
    await rebuildLocked(deps.db, id);
    await yieldToEventLoop();
  }
  return deps.embedder === null ? NO_EMBEDS : embedContextDocs(deps.db, deps.embedder, ids);
};

/** One run of the pass: its page size, and where it says how far it got. */
interface Run {
  readonly deps: Deps;
  readonly batch: number;
  readonly progress: (line: string) => void;
  readonly progressEveryPages: number;
  /** Docs waiting when the run began — what "X of N" counts against. */
  readonly pending: number;
}

const upgradeFrom = async (run: Run, after: string, pages: number, done: DocUpgradeReport): Promise<DocUpgradeReport> => {
  const ids = await stalePage(run.deps.db, after, run.batch);
  const last = ids[ids.length - 1];
  if (last === undefined) {
    return done;
  }
  const embeds = await upgradePage(run.deps, ids);
  const next: DocUpgradeReport = {
    ...done,
    contexts: done.contexts + ids.length,
    reembedded: done.reembedded + embeds.embedded,
    embedFailures: done.embedFailures + embeds.failed,
  };
  if ((pages + 1) % run.progressEveryPages === 0) {
    run.progress(`${String(next.contexts)} of ${String(run.pending)} rebuilt`);
  }
  // No turn of its own between pages: the page's rebuilds each took one
  // (upgradePage), and an embed call is network I/O.
  return upgradeFrom(run, last, pages + 1, next);
};

const SILENT = (): void => undefined;

export const upgradeNormalizedDocs = async (
  deps: Deps,
  options: {
    readonly batch?: number;
    /** Where the pass says it started and how far it got (review round 4, M2). */
    readonly progress?: (line: string) => void;
    readonly progressEveryPages?: number;
    /** Declared-only contexts stamped per UPDATE (round 5). */
    readonly stampBatch?: number;
  } = {},
): Promise<DocUpgradeReport> => {
  const stamped = await stampFrom(deps.db, options.stampBatch ?? DOC_UPGRADE_STAMP_BATCH, BEFORE_EVERY_ID, 0);
  await yieldToEventLoop();
  const pending = await countPendingDocs(deps.db);
  const progress = options.progress ?? SILENT;
  if (pending > 0) {
    progress(
      `starting: ${String(pending)} work context doc(s) still fold drafts in; ` +
        "until each is rebuilt it is found by its claims only",
    );
  }
  await yieldToEventLoop();
  const run: Run = {
    deps,
    batch: options.batch ?? DOC_UPGRADE_BATCH,
    progress,
    progressEveryPages: options.progressEveryPages ?? DOC_UPGRADE_PROGRESS_PAGES,
    pending,
  };
  return upgradeFrom(run, BEFORE_EVERY_ID, 0, { contexts: 0, stamped, reembedded: 0, embedFailures: 0 });
};
