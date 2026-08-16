import { and, asc, desc, gt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { EVENTS_MAX_LIMIT } from "../constants.ts";
import { events } from "../db/schema.ts";
import type { Db, DbExecutor } from "../db/client.ts";
import type { Clock } from "../types.ts";

export interface EventView {
  readonly id: number;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
}

export interface EventsCursorQuery {
  readonly after: number;
  readonly limit: number;
}

type EventRow = typeof events.$inferSelect;

const toEventView = (row: EventRow): EventView => ({
  id: row.id,
  kind: row.kind,
  payload: row.payload,
  createdAt: row.createdAt.toISOString(),
});

/** Outbox append — payloads carry only ids and metadata, never claim bodies. */
export const appendEvent = async (
  deps: { readonly db: DbExecutor; readonly now: Clock },
  kind: string,
  payload: Record<string, unknown>,
): Promise<void> => {
  await deps.db.insert(events).values({ kind, payload, createdAt: deps.now() });
};

/**
 * Read-time presence filter (services/visibility.ts): opt-out is a live
 * switch over an append-only outbox, so rows written before the toggle are
 * hidden or restored by the CURRENT flag. The filter keys on
 * payload-developerId ATTRIBUTION, not on kind: every attributed row
 * carries a server timestamp, so knowledge kinds are a live activity
 * timeline too — work_context_created fires when the subject STARTS a piece
 * of work, which is exactly the signal opt-out exists to hide. The
 * knowledge itself stays visible and attributed on every pull surface; only
 * its feed rows hide. In the WHERE, not after the LIMIT — a filtered page
 * must not shortchange the cursor. Rows without a payload developerId keep
 * flowing.
 *
 * ONE definition, shared by every reader of the outbox — the SSE/API cursor
 * read below and the web feed's newest-first read — so a surface cannot
 * drift out from under the opt-out (ui-feed.test.ts pins the web side).
 */
const subjectVisibleToViewer = (viewerDeveloperId: string): SQL =>
  sql`NOT EXISTS (
    SELECT 1 FROM developers privacy_subject
    WHERE privacy_subject.id = ${events.payload}->>'developerId'
      AND privacy_subject.presence_opt_out
      AND privacy_subject.id <> ${viewerDeveloperId}
  )`;

export const listEventsAfter = async (
  db: Db,
  viewerDeveloperId: string,
  query: EventsCursorQuery,
): Promise<EventView[]> => {
  const cappedLimit = Math.min(query.limit, EVENTS_MAX_LIMIT);
  const rows = await db
    .select()
    .from(events)
    .where(
      and(gt(events.id, query.after), subjectVisibleToViewer(viewerDeveloperId)),
    )
    .orderBy(asc(events.id))
    .limit(cappedLimit);
  return rows.map(toEventView);
};

/**
 * Newest-first page for the web feed (/ui/feed) — the same reader as
 * listEventsAfter (same table, same visibility condition, same cap), in the
 * order a human reads a feed. NOT a second events query in the sense the
 * design forbids: the opt-out filter above is the single shared definition,
 * so this cannot show a row the cursor read would hide.
 */
export const listRecentEvents = async (
  db: Db,
  viewerDeveloperId: string,
  limit: number,
): Promise<EventView[]> => {
  const cappedLimit = Math.min(limit, EVENTS_MAX_LIMIT);
  const rows = await db
    .select()
    .from(events)
    .where(subjectVisibleToViewer(viewerDeveloperId))
    .orderBy(desc(events.id))
    .limit(cappedLimit);
  return rows.map(toEventView);
};
