import { and, asc, gt, sql } from "drizzle-orm";

import { EVENTS_MAX_LIMIT, EVENT_KINDS } from "../constants.ts";
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
 * The kinds that ARE live presence on the wire: their payloads say when a
 * named developer's agent started and stopped. Knowledge kinds (work
 * contexts, claims, edges) are deliberately not here — opt-out never
 * retracts published knowledge (services/visibility.ts).
 */
const PRESENCE_EVENT_KINDS = [
  EVENT_KINDS.SESSION_STARTED,
  EVENT_KINDS.SESSION_ENDED,
] as const;

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
      and(
        gt(events.id, query.after),
        // Read-time presence filter (services/visibility.ts): opt-out is a
        // live switch over an append-only outbox, so rows written before the
        // toggle are hidden or restored by the CURRENT flag. In the WHERE,
        // not after the LIMIT — a filtered page must not shortchange the
        // cursor. Rows without a payload developerId keep flowing.
        sql`NOT (
          ${events.kind} IN (${sql.join(
            PRESENCE_EVENT_KINDS.map((kind) => sql`${kind}`),
            sql`, `,
          )})
          AND EXISTS (
            SELECT 1 FROM developers privacy_subject
            WHERE privacy_subject.id = ${events.payload}->>'developerId'
              AND privacy_subject.presence_opt_out
              AND privacy_subject.id <> ${viewerDeveloperId}
          )
        )`,
      ),
    )
    .orderBy(asc(events.id))
    .limit(cappedLimit);
  return rows.map(toEventView);
};