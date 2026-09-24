/**
 * THE SKELETON SWEEP'S BUDGET, MEASURED (1.0 spec 01a §6) — the number behind
 * SESSION_EVENT_SWEEP_WINDOW in src/constants.ts.
 *
 *   bun packages/server/scripts/measure-skeleton-sweep.ts [interim|full]
 *
 * The shape the adversarial review asked for, not the flattering one: 20 000
 * sessions ended 40 days back with 20 rows each (400 000 rows), half of every
 * session's rows `file.modified` with a resolved identity, 200 pins with
 * histories in the same repo, and a third of the sessions kept by a claim —
 * so every clause the registry generates runs on every judged session. It
 * runs passes until one full cycle completes and prints the per-pass cost and
 * what the cycle judged. In-memory PGlite; nothing is written anywhere else.
 */
import { sql } from "drizzle-orm";

import { createDb } from "../src/db/client.ts";
import { readSkeletonRetentionReport, sweepSkeleton } from "../src/services/retention.ts";

const MODE = process.argv[2] === "full" ? "full" : "interim";
const SESSIONS = 20_000;
const ROWS_PER_SESSION = 20;
const PINS = 200;
const DAYS_ENDED_AGO = 40;
const MS_PER_DAY = 86_400_000;

const db = await createDb();
const now = new Date("2026-09-24T00:00:00Z");
const ended = new Date(now.getTime() - DAYS_ENDED_AGO * MS_PER_DAY);

await db.execute(sql`INSERT INTO developers (id, name, email, api_key_hash, created_at)
  VALUES ('dev', 'Nick', 'n@example.com', 'x', ${ended})`);
await db.execute(sql`INSERT INTO agent_sessions
    (id, developer_id, agent_kind, repo, branch, base_commit, status, started_at, last_heartbeat_at, ended_at)
  SELECT 'ses_' || lpad(g::text, 6, '0'), 'dev', 'claude-code', 'github.com/acme/api', 'main', 'a1b2c3d', 'done',
         ${ended}, ${ended}, ${ended}::timestamptz + (g || ' seconds')::interval
  FROM generate_series(1, ${SESSIONS}) g`);
await db.execute(sql`INSERT INTO work_contexts (id, session_id, title, status, created_at)
  SELECT 'wc_' || lpad(g::text, 6, '0'), 'ses_' || lpad(g::text, 6, '0'), 't', 'active', ${ended}
  FROM generate_series(1, ${SESSIONS}) g`);
await db.execute(sql`INSERT INTO session_events
    (id, session_id, kind, seq_kind, seq_reason, ref_kind, ref_id, observed_at, provider, file_ref)
  SELECT 'se_' || s || '_' || n, 'ses_' || lpad(s::text, 6, '0'),
         CASE WHEN n % 2 = 0 THEN 'file.modified' ELSE 'claim.created' END,
         'observed', 'pre_seq_connector', 'target_digest', md5(s::text || '/' || n::text), ${ended}, 'claude-code',
         CASE WHEN n % 2 = 0 THEN md5('file' || ((s * 7 + n) % 5000)::text) ELSE NULL END
  FROM generate_series(1, ${SESSIONS}) s, generate_series(1, ${ROWS_PER_SESSION}) n`);
await db.execute(sql`INSERT INTO pins
    (id, repo, surface, verified_by, verified_at_commit, verified_at, check_recipe, capture_mode, created_at)
  SELECT 'pin_' || g, 'github.com/acme/api', 's', 'dev', 'abc1234', ${ended}, 'c', 'human_terminal', ${ended}
  FROM generate_series(1, ${PINS}) g`);
await db.execute(sql`INSERT INTO pin_files (pin_id, repo, path, status)
  SELECT 'pin_' || g, 'github.com/acme/api', 'src/f' || g || '.ts', 'present' FROM generate_series(1, ${PINS}) g`);
await db.execute(sql`INSERT INTO pin_file_refs (pin_id, file_ref, first_seen)
  SELECT 'pin_' || g, md5('file' || (g * 13)::text), ${ended} FROM generate_series(1, ${PINS}) g`);
await db.execute(sql`INSERT INTO claims
    (id, work_context_id, author_session_id, kind, body, status, confidence, capture_mode, provenance, evidence_refs, created_at)
  SELECT 'clm_' || g, 'wc_' || lpad(g::text, 6, '0'), 'ses_' || lpad(g::text, 6, '0'), 'observation', 'b ' || g,
         'proposed', 0.5, 'agent', 'declared', '[]'::jsonb, ${ended}
  FROM generate_series(1, ${SESSIONS}, 3) g`);

const deps = { db, now: () => now };
const times: number[] = [];
for (;;) {
  const started = performance.now();
  await sweepSkeleton(deps, { mode: MODE });
  times.push(performance.now() - started);
  const report = await readSkeletonRetentionReport(deps);
  if (report.completedAt === null) {
    continue;
  }
  const sorted = [...times].sort((a, b) => a - b);
  const reportStarted = performance.now();
  await readSkeletonRetentionReport(deps);
  console.log(
    `mode ${MODE}: ${String(times.length)} passes to one cycle; per pass ms median ` +
      `${(sorted[Math.floor(sorted.length / 2)] ?? 0).toFixed(0)}, max ${(sorted.at(-1) ?? 0).toFixed(0)}; ` +
      `report read ${(performance.now() - reportStarted).toFixed(1)} ms`,
  );
  console.log(
    JSON.stringify({
      aged: report.aged,
      swept: report.swept,
      keptBy: report.keptBy.filter((row) => row.sessions > 0),
      fileBearing: report.fileBearing,
    }),
  );
  break;
}
