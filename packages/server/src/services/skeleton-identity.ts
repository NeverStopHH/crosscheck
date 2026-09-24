/**
 * THE SKELETON'S OWN IDENTITY COLUMNS (1.0 spec 01a §3.2, §3.3d, §4.1, §4.3).
 *
 * A `session_events` row answers WHICH SESSION, WHICH EPOCH, WHICH POSITION.
 * 01a asks it to answer three more questions without reading a content row:
 * which vendor (`provider`), which work context (`work_context_id`), and —
 * on a `file.modified` row only — which FILE (`file_ref`), in the identity a
 * pin's history (`pin_file_refs`) is written in, so that the retention graph
 * can join a human's pin to a session's touch by one exact value.
 *
 * NEW ROWS ARE WRITTEN COMPLETE by the projection (services/session-events.ts
 * and record-handlers.ts) and by the pin writers (services/pins.ts). THE
 * BACKFILL BELOW IS FOR WHAT ALREADY EXISTS.
 *
 * WHAT IT CANNOT REACH IS LEFT NULL, NEVER GUESSED, AND COUNTED. A NULL
 * `file_ref` on a `file.modified` row is exactly §3.3e's `unresolved`: the
 * sweep keeps its whole session. A backfill that filled it with something
 * plausible would turn "we could not tell" into "nobody references this" —
 * a deletion licence minted by a migration.
 */
import { canonicalRepoPath, fileRef } from "@crosscheck/schema";
import type { PinFileRefUnresolvedReason } from "@crosscheck/schema";
import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { SKELETON_BACKFILL_BATCH } from "../constants.ts";
import type { DbExecutor } from "../db/client.ts";
import { pinFileRefs, pinFiles } from "../db/schema.ts";
import type { Clock } from "../types.ts";

interface Deps {
  readonly db: DbExecutor;
  readonly now: Clock;
}

/** One row of a pin's identity history, as every writer computes it. */
export interface PinFileRefRow {
  readonly pinId: string;
  readonly fileRef: string | null;
  readonly unresolvedReason: PinFileRefUnresolvedReason | null;
}

/**
 * The identity a stored pin path is written under — or the unresolved marker
 * when the path has no canonical spelling. ONE function for creation, the
 * sweep's rename and the seed, so the three writers cannot disagree.
 */
export const pinFileRefRow = (
  pinId: string,
  repo: string,
  path: string,
): PinFileRefRow => {
  const canonical = canonicalRepoPath(path);
  if (!canonical.ok) {
    return { pinId, fileRef: null, unresolvedReason: "path_not_canonical" };
  }
  const identity = identityOf(repo, canonical.path);
  return identity === null
    ? { pinId, fileRef: null, unresolvedReason: "repo_not_canonical" }
    : { pinId, fileRef: identity, unresolvedReason: null };
};

/**
 * `fileRef`, or null when the repo identity carries the identity's separator
 * — `fileRef` refuses such a value by throwing, and one legacy row must not
 * stop a start-up backfill for the whole hub, nor an ingest after its target
 * row is already stored. Null is UNRESOLVED, and unresolved is kept.
 */
const identityOf = (repo: string, canonicalPath: string): string | null => {
  try {
    return fileRef(repo, canonicalPath);
  } catch {
    return null;
  }
};

/**
 * APPEND-ONLY (§3.3d): a pin's history keeps every identity it has watched,
 * so a rename never severs the pin from the sessions that touched the old
 * name. A second write of a known identity is a no-op — including the one
 * NULL marker a pin may carry (a partial unique index holds it to one).
 */
export const recordPinFileRefs = async (
  db: DbExecutor,
  rows: readonly PinFileRefRow[],
  now: Date,
): Promise<void> => {
  if (rows.length === 0) {
    return;
  }
  await db
    .insert(pinFileRefs)
    .values(rows.map((row) => ({ ...row, firstSeen: now })))
    .onConflictDoNothing();
};

/** A `file.modified` target's identity, or null — unresolved — when its path has none. */
export const touchFileRef = (repo: string, value: string): string | null => {
  const canonical = canonicalRepoPath(value);
  return canonical.ok ? identityOf(repo, canonical.path) : null;
};

export interface SkeletonBackfillReport {
  /** Legacy pin paths moved to their one spelling (`./src/x.ts` → `src/x.ts`). */
  readonly pinPathsCanonicalised: number;
  /** Legacy pins given an identity history. */
  readonly pinsSeeded: number;
  readonly providers: number;
  readonly workContexts: number;
  readonly fileRefs: number;
  /** `file.modified` rows left NULL: §3.3e keeps their whole sessions. */
  readonly unresolvedFileRefs: number;
}

/**
 * EVERY FILE A PIN WATCHES HAS ITS IDENTITY IN THE PIN'S HISTORY — checked
 * row by row on every start, never inferred from "the pin has some history".
 * A pin whose history is PARTIAL (a start whose seed failed, then a rename)
 * would otherwise read as resolved while one of its files matched nothing.
 * Pins are few (a hub's target is 5 000), so the whole check is two reads.
 *
 * A PIN WITH NO HISTORY AT ALL THAT WAS EVER RENAMED gets the NULL marker as
 * well: it predates this table, the names it watched before the rename were
 * deleted from `pin_files` by the sweep that renamed them, and the sessions
 * that touched those names cannot be found from anything this hub still
 * holds. That is unresolved, and unresolved is KEEP (§3.3e) — the price is
 * the repo-wide freeze §3.3e names, printed by `doctor` with the pin's id.
 */
/**
 * A PIN STORED BEFORE THE DOOR TAKES THE ONE SPELLING TOO. `pin_files.path` is
 * the string `suspect` intersects with a session's touches, exactly, and the
 * hub now canonicalises every touch it ingests — so a legacy `./src/x.ts`
 * would match no touch at all after the upgrade (the retention graph is fine
 * either way: it joins on the canonical identity). Each such row is moved to
 * its canonical path, keeping its status; where the pin already watches that
 * path, the existing row stands and the legacy one goes. A path with no
 * canonical spelling is left as it is: its identity is already unresolved.
 */
const canonicaliseLegacyPinPaths = async (deps: Deps): Promise<number> => {
  const rows = await deps.db
    .select({ pinId: pinFiles.pinId, repo: pinFiles.repo, path: pinFiles.path, status: pinFiles.status })
    .from(pinFiles);
  let moved = 0;
  for (const row of rows) {
    const canonical = canonicalRepoPath(row.path);
    if (!canonical.ok || canonical.path === row.path) {
      continue;
    }
    await deps.db.transaction(async (tx) => {
      await tx
        .insert(pinFiles)
        .values({ pinId: row.pinId, repo: row.repo, path: canonical.path, status: row.status })
        .onConflictDoNothing();
      await tx
        .delete(pinFiles)
        .where(and(eq(pinFiles.pinId, row.pinId), eq(pinFiles.path, row.path)));
    });
    moved += 1;
  }
  return moved;
};

const seedPinFileRefs = async (deps: Deps): Promise<number> => {
  const files = await deps.db.execute(sql`
    SELECT pf.pin_id AS pin_id, pf.repo AS repo, pf.path AS path, p.renamed_paths AS renamed,
           EXISTS (SELECT 1 FROM pin_file_refs pr WHERE pr.pin_id = pf.pin_id) AS has_history
      FROM pin_files pf
      JOIN pins p ON p.id = pf.pin_id
     ORDER BY pf.pin_id, pf.path`);
  const known = new Set(
    (await deps.db.execute(sql`SELECT pin_id, file_ref FROM pin_file_refs`)).rows.map(
      (row) => `${String(row["pin_id"])}\n${String(row["file_ref"])}`,
    ),
  );
  const byPin = new Map<string, PinFileRefRow[]>();
  for (const raw of files.rows) {
    const row = raw as { pin_id: string; repo: string; path: string; renamed: number; has_history: boolean };
    const missing: PinFileRefRow[] = [];
    if (!row.has_history && Number(row.renamed) > 0) {
      missing.push({ pinId: row.pin_id, fileRef: null, unresolvedReason: "rename_history_unrecorded" });
    }
    const current = pinFileRefRow(row.pin_id, row.repo, row.path);
    missing.push(current);
    const absent = missing.filter((entry) => !known.has(`${entry.pinId}\n${String(entry.fileRef)}`));
    if (absent.length > 0) {
      byPin.set(row.pin_id, [...(byPin.get(row.pin_id) ?? []), ...absent]);
    }
  }
  for (const rows of byPin.values()) {
    await recordPinFileRefs(deps.db, rows, deps.now());
  }
  return byPin.size;
};

/**
 * ONE PAGE AT A TIME, never one UPDATE over the table. PGlite serves one
 * statement at a time, so a whole-table UPDATE on a large hub would hold every
 * hook request behind it for as long as it ran. Each page is a keyset slice
 * of the rows still missing a value (`pending`), and `write` is the UPDATE
 * restricted to that page's ids; a page whose rows cannot be filled still
 * moves the cursor, so the walk ends.
 */
const pagedUpdate = async (
  deps: Deps,
  batch: number,
  pending: SQL,
  write: (page: SQL) => SQL,
): Promise<number> => {
  let cursor = "";
  let written = 0;
  for (;;) {
    const result = await deps.db.execute(sql`
      WITH page AS (
        SELECT se.id FROM session_events se
         WHERE ${pending} AND se.id > ${cursor}
         ORDER BY se.id
         LIMIT ${batch}
      ),
      written AS (${write(sql`SELECT id FROM page`)} RETURNING 1)
      SELECT (SELECT count(*)::int FROM written) AS written,
             (SELECT max(id) FROM page) AS last`);
    const row = (result.rows[0] ?? {}) as { written?: number; last?: string | null };
    written += Number(row.written ?? 0);
    if (row.last === null || row.last === undefined) {
      return written;
    }
    cursor = String(row.last);
  }
};

/** Exact: one `agent_kind` per session, so the copy cannot disagree with its source. */
const backfillProviders = (deps: Deps, batch: number): Promise<number> =>
  pagedUpdate(
    deps,
    batch,
    sql`se.provider IS NULL`,
    (page) => sql`UPDATE session_events se SET provider = s.agent_kind
                    FROM agent_sessions s
                   WHERE s.id = se.session_id AND se.id IN (${page})`,
  );

/**
 * A claim row's work context is its claim's. An invalidation's is the
 * INVALIDATING claim's — the edge's `from` side, the assertion this session
 * made — because an edge has no work context of its own.
 */
const backfillClaimContexts = async (deps: Deps, batch: number): Promise<number> =>
  (await pagedUpdate(
    deps,
    batch,
    sql`se.kind = 'claim.created' AND se.ref_kind = 'claim' AND se.work_context_id IS NULL`,
    (page) => sql`UPDATE session_events se SET work_context_id = c.work_context_id
                    FROM claims c
                   WHERE c.id = se.ref_id AND se.id IN (${page})`,
  )) +
  (await pagedUpdate(
    deps,
    batch,
    sql`se.kind = 'claim.invalidated' AND se.ref_kind = 'claim_edge' AND se.work_context_id IS NULL`,
    (page) => sql`UPDATE session_events se SET work_context_id = c.work_context_id
                    FROM claim_edges e JOIN claims c ON c.id = e.from_claim_id
                   WHERE e.id = se.ref_id AND se.id IN (${page})`,
  ));

interface TargetMatch {
  readonly id: string;
  readonly kind: string;
  readonly repo: string;
  readonly workContextId: string | null;
  readonly value: string | null;
}

/**
 * One keyset page of target-projected rows still missing an identity, each
 * matched to the target it was projected from by recomputing `targetDigest`
 * IN SQL — over the targets of this page's sessions only, so a page costs
 * its own sessions' targets and never a scan of every target on the hub.
 */
const targetPage = async (
  deps: Deps,
  cursor: string,
  batch: number,
): Promise<readonly TargetMatch[]> => {
  const result = await deps.db.execute(sql`
    WITH batch AS (
      SELECT se.id, se.session_id, se.kind, se.ref_id
        FROM session_events se
       WHERE se.ref_kind = 'target_digest'
         AND (se.work_context_id IS NULL
              OR (se.kind = 'file.modified' AND se.file_ref IS NULL))
         AND se.id > ${cursor}
       ORDER BY se.id
       LIMIT ${batch}
    ),
    digests AS (
      SELECT t.work_context_id, t.value,
             encode(sha256(convert_to(
               t.work_context_id || E'\\n' || t.kind || E'\\n' || t.value, 'UTF8')), 'hex') AS digest
        FROM work_context_targets t
        JOIN work_contexts wc ON wc.id = t.work_context_id
       WHERE wc.session_id IN (SELECT session_id FROM batch)
    )
    SELECT b.id, b.kind, s.repo, d.work_context_id, d.value
      FROM batch b
      JOIN agent_sessions s ON s.id = b.session_id
      LEFT JOIN digests d ON d.digest = b.ref_id
     ORDER BY b.id`);
  return result.rows.map((raw) => {
    const row = raw as {
      id: string;
      kind: string;
      repo: string;
      work_context_id: string | null;
      value: string | null;
    };
    return {
      id: row.id,
      kind: row.kind,
      repo: row.repo,
      workContextId: row.work_context_id,
      value: row.value,
    };
  });
};

const backfillTargets = async (
  deps: Deps,
  batch: number,
): Promise<{ readonly workContexts: number; readonly fileRefs: number; readonly unresolved: number }> => {
  let cursor = "";
  let workContexts = 0;
  let fileRefs = 0;
  let unresolved = 0;
  for (;;) {
    const page = await targetPage(deps, cursor, batch);
    const last = page.at(-1);
    if (last === undefined) {
      return { workContexts, fileRefs, unresolved };
    }
    cursor = last.id;
    const updates = page.map((match) => ({
      id: match.id,
      workContextId: match.workContextId,
      fileRef:
        match.kind === "file.modified" && match.value !== null
          ? touchFileRef(match.repo, match.value)
          : null,
    }));
    unresolved += page.filter(
      (match, index) => match.kind === "file.modified" && updates[index]?.fileRef === null,
    ).length;
    const writable = updates.filter(
      (update) => update.workContextId !== null || update.fileRef !== null,
    );
    if (writable.length === 0) {
      continue;
    }
    workContexts += writable.filter((update) => update.workContextId !== null).length;
    fileRefs += writable.filter((update) => update.fileRef !== null).length;
    await deps.db.execute(sql`
      UPDATE session_events se
         SET work_context_id = COALESCE(se.work_context_id, v.wc),
             file_ref = COALESCE(se.file_ref, v.fr)
        FROM (VALUES ${sql.join(
          writable.map(
            (update) =>
              sql`(${update.id}::text, ${update.workContextId}::text, ${update.fileRef}::text)`,
          ),
          sql`, `,
        )}) AS v(id, wc, fr)
       WHERE se.id = v.id`);
  }
};

/**
 * RUN ON EVERY HUB START, and idempotent: each step selects only what is
 * still missing. Safe to run beside live ingest — new rows arrive complete,
 * and every UPDATE fills a NULL and never overwrites a value — and safe to
 * run late: until it has, a missing identity reads as unresolved, and the
 * sweep keeps what it cannot resolve (services/retention.ts).
 */
export const backfillSkeletonIdentity = async (
  deps: Deps,
  options: { readonly batch?: number } = {},
): Promise<SkeletonBackfillReport> => {
  const batch = options.batch ?? SKELETON_BACKFILL_BATCH;
  const pinPathsCanonicalised = await canonicaliseLegacyPinPaths(deps);
  const pinsSeeded = await seedPinFileRefs(deps);
  const providers = await backfillProviders(deps, batch);
  const claimContexts = await backfillClaimContexts(deps, batch);
  const targets = await backfillTargets(deps, batch);
  // EVERY UPDATE LEFT A DEAD ROW VERSION BEHIND, and PGlite runs no
  // autovacuum: without this the backfill would double the table for good.
  // Once, only when something was written — so every later start skips it.
  if (providers + claimContexts + targets.workContexts + targets.fileRefs > 0) {
    await deps.db.execute(sql`VACUUM session_events`);
  }
  return {
    pinPathsCanonicalised,
    pinsSeeded,
    providers,
    workContexts: claimContexts + targets.workContexts,
    fileRefs: targets.fileRefs,
    unresolvedFileRefs: targets.unresolved,
  };
};
