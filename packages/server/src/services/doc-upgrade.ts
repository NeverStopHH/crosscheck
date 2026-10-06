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
 * contexts; the rebuild clears the context's embedding (a vector of the old
 * doc no longer describes the new one), and with an embedder the same page
 * is re-embedded right after — the vector tier misses a context only between
 * the two, never for good.
 *
 * Run AFTER the hub is serving (index.ts), in the background: until it has
 * run, an old doc only keeps matching as it did before the upgrade, so
 * nothing waits on it — and a large hub is not held offline while it runs.
 */
import { and, asc, eq, exists, gt, lt, ne, sql } from "drizzle-orm";

import { DOC_UPGRADE_BATCH } from "../constants.ts";
import type { Db } from "../db/client.ts";
import { claims, workContexts } from "../db/schema.ts";
import type { Embedder } from "./embedder.ts";
import { embedContextDoc, NORMALIZED_DOC_VERSION, refreshNormalizedDoc } from "./normalized-doc.ts";
import { DECLARED_PROVENANCE } from "./similarity-gate.ts";

interface Deps {
  readonly db: Db;
  readonly embedder: Embedder | null;
}

export interface DocUpgradeReport {
  /** Contexts whose doc this run rebuilt. */
  readonly contexts: number;
  /** Of those, the ones handed to the embedder afterwards. */
  readonly reembedded: number;
}

/** No id sorts before this, so the first page starts at the beginning. */
const BEFORE_EVERY_ID = "";

/** One page of contexts still built under an older rule that hold a non-declared claim. */
const stalePage = async (db: Db, after: string, batch: number): Promise<readonly string[]> => {
  const rows = await db
    .select({ id: workContexts.id })
    .from(workContexts)
    .where(
      and(
        gt(workContexts.id, after),
        lt(workContexts.docVersion, NORMALIZED_DOC_VERSION),
        exists(
          db
            .select({ one: sql`1` })
            .from(claims)
            .where(and(eq(claims.workContextId, workContexts.id), ne(claims.provenance, DECLARED_PROVENANCE))),
        ),
      ),
    )
    .orderBy(asc(workContexts.id))
    .limit(batch);
  return rows.map((row) => row.id);
};

/** Rebuilds, then (with an embedder) re-embeds, one page — one context at a time. */
const upgradePage = async (deps: Deps, ids: readonly string[]): Promise<number> => {
  for (const id of ids) {
    await refreshNormalizedDoc(deps.db, id);
  }
  if (deps.embedder === null) {
    return 0;
  }
  for (const id of ids) {
    await embedContextDoc(deps.db, deps.embedder, id);
  }
  return ids.length;
};

/**
 * A turn of the event loop. PGlite runs each statement synchronously and an
 * awaited query settles through microtasks only, so a chain of them never
 * lets a timer or an incoming request run: without this between pages, the
 * whole pass held every request — the review measured one at 18 873 ms
 * during a 30 000-context keyless pass (round 4, H1).
 */
const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

const upgradeFrom = async (
  deps: Deps,
  batch: number,
  after: string,
  done: DocUpgradeReport,
): Promise<DocUpgradeReport> => {
  const ids = await stalePage(deps.db, after, batch);
  const last = ids[ids.length - 1];
  if (last === undefined) {
    return done;
  }
  const reembedded = await upgradePage(deps, ids);
  await yieldToEventLoop();
  return upgradeFrom(deps, batch, last, {
    contexts: done.contexts + ids.length,
    reembedded: done.reembedded + reembedded,
  });
};

export const upgradeNormalizedDocs = (
  deps: Deps,
  options: { readonly batch?: number } = {},
): Promise<DocUpgradeReport> =>
  upgradeFrom(deps, options.batch ?? DOC_UPGRADE_BATCH, BEFORE_EVERY_ID, { contexts: 0, reembedded: 0 });
