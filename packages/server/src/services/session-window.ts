/**
 * WHICH SESSIONS A REPORT WINDOW HOLDS (DESIGN.md "One session, many topics").
 *
 * A window used to hold the sessions that STARTED in it. The owner works from
 * one long-lived session — weeks old, every topic in it — and every report
 * over the last week counted none of that week's work: the session began
 * before the window opened. So a session belongs to [since, until) when it
 * started in it OR any of its work contexts holds a target first seen or last
 * seen in it (`work_context_targets.created_at` / `last_seen_at`): its WORK
 * dates it, not its start.
 *
 * The session must be aliased `s` in the query this joins — every pilot and
 * report query names it so. A target from before `last_seen_at` existed reads
 * as its `created_at`, and one from before that as nothing: an unplaceable row
 * dates no session, the direction that under-counts rather than invents.
 */
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

export const sessionActiveIn = (since: Date, until: Date): SQL => {
  const from = since.toISOString();
  const to = until.toISOString();
  return sql`((s.started_at >= ${from}::timestamptz AND s.started_at < ${to}::timestamptz)
    OR EXISTS (
      SELECT 1 FROM work_contexts wc_window
      JOIN work_context_targets t_window ON t_window.work_context_id = wc_window.id
      WHERE wc_window.session_id = s.id
        AND coalesce(t_window.last_seen_at, t_window.created_at) >= ${from}::timestamptz
        AND coalesce(t_window.last_seen_at, t_window.created_at) < ${to}::timestamptz))`;
};
