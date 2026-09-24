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
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { SKELETON_BACKFILL_BATCH } from "../constants.ts";
import type { DbExecutor } from "../db/client.ts";
import { pinFileRefs } from "../db/schema.ts";
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
  return canonical.ok
    ? { pinId, fileRef: fileRef(repo, canonical.path), unresolvedReason: null }
    : { pinId, fileRef: null, unresolvedReason: "path_not_canonical" };
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
  return canonical.ok ? fileRef(repo, canonical.path) : null;
};

export interface SkeletonBackfillReport {
  /** Legacy pins given an identity history. */
  readonly pinsSeeded: number;
  readonly providers: number;
  readonly workContexts: number;
  readonly fileRefs: number;
  /** `file.modified` rows left NULL: §3.3e keeps their whole sessions. */
  readonly unresolvedFileRefs: number;
}

const countOf = async (db: DbExecutor, statement: SQL): Promise<number> => {
  const result = await db.execute(
    sql`WITH changed AS (${statement} RETURNING 1) SELECT count(*)::int AS n FROM changed`,
  );
  return Number((result.rows[0] as { n?: number } | undefined)?.n ?? 0);
};

/**
 * A PIN WITH NO HISTORY IS A PIN FROM BEFORE THIS TABLE — every pin created
 * since writes its history in the same transaction as its files — so "no
 * row" is the whole criterion, and a re-run finds nothing to do.
 *
 * A LEGACY PIN THAT WAS EVER RENAMED gets the NULL marker as well: the names
 * it watched before the rename were deleted from `pin_files` by the sweep
 * that renamed them, so the sessions that touched those names cannot be found
 * from anything this hub still holds. That is unresolved, and unresolved is
 * KEEP (§3.3e) — the price is the repo-wide freeze §3.3e names, printed by
 * `doctor` so a person can see it and retire the pin.
 */
const seedPinFileRefs = async (deps: Deps): Promise<number> => {
  const legacy = await deps.db.execute(sql`
    SELECT p.id AS pin_id, p.repo AS repo, p.renamed_paths AS renamed, pf.path AS path
      FROM pins p
      JOIN pin_files pf ON pf.pin_id = p.id
     WHERE NOT EXISTS (SELECT 1 FROM pin_file_refs pr WHERE pr.pin_id = p.id)
     ORDER BY p.id`);
  const byPin = new Map<string, PinFileRefRow[]>();
  for (const raw of legacy.rows) {
    const row = raw as { pin_id: string; repo: string; renamed: number; path: string };
    const rows = byPin.get(row.pin_id) ?? [];
    if (rows.length === 0 && Number(row.renamed) > 0) {
      rows.push({
        pinId: row.pin_id,
        fileRef: null,
        unresolvedReason: "rename_history_unrecorded",
      });
    }
    rows.push(pinFileRefRow(row.pin_id, row.repo, row.path));
    byPin.set(row.pin_id, rows);
  }
  for (const rows of byPin.values()) {
    await recordPinFileRefs(deps.db, rows, deps.now());
  }
  return byPin.size;
};

/** Exact: one `agent_kind` per session, so the copy cannot disagree with its source. */
const backfillProviders = (deps: Deps): Promise<number> =>
  countOf(
    deps.db,
    sql`UPDATE session_events se SET provider = s.agent_kind
          FROM agent_sessions s
         WHERE s.id = se.session_id AND se.provider IS NULL`,
  );

/**
 * A claim row's work context is its claim's. An invalidation's is the
 * INVALIDATING claim's — the edge's `from` side, the assertion this session
 * made — because an edge has no work context of its own.
 */
const backfillClaimContexts = async (deps: Deps): Promise<number> =>
  (await countOf(
    deps.db,
    sql`UPDATE session_events se SET work_context_id = c.work_context_id
          FROM claims c
         WHERE se.kind = 'claim.created' AND se.ref_kind = 'claim'
           AND c.id = se.ref_id AND se.work_context_id IS NULL`,
  )) +
  (await countOf(
    deps.db,
    sql`UPDATE session_events se SET work_context_id = c.work_context_id
          FROM claim_edges e JOIN claims c ON c.id = e.from_claim_id
         WHERE se.kind = 'claim.invalidated' AND se.ref_kind = 'claim_edge'
           AND e.id = se.ref_id AND se.work_context_id IS NULL`,
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
       LIMIT ${SKELETON_BACKFILL_BATCH}
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
): Promise<{ readonly workContexts: number; readonly fileRefs: number; readonly unresolved: number }> => {
  let cursor = "";
  let workContexts = 0;
  let fileRefs = 0;
  let unresolved = 0;
  for (;;) {
    const page = await targetPage(deps, cursor);
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
): Promise<SkeletonBackfillReport> => {
  const pinsSeeded = await seedPinFileRefs(deps);
  const providers = await backfillProviders(deps);
  const claimContexts = await backfillClaimContexts(deps);
  const targets = await backfillTargets(deps);
  return {
    pinsSeeded,
    providers,
    workContexts: claimContexts + targets.workContexts,
    fileRefs: targets.fileRefs,
    unresolvedFileRefs: targets.unresolved,
  };
};
