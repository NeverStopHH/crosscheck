import { asc, gt } from "drizzle-orm";

import { EVENTS_MAX_LIMIT } from "../constants.ts";
import { events } from "../db/schema.ts";
import type { Db } from "../db/client.ts";
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
  deps: { readonly db: Db; readonly now: Clock },
  kind: string,
  payload: Record<string, unknown>,
): Promise<void> => {
  await deps.db.insert(events).values({ kind, payload, createdAt: deps.now() });
};

export const listEventsAfter = async (
  db: Db,
  query: EventsCursorQuery,
): Promise<EventView[]> => {
  const cappedLimit = Math.min(query.limit, EVENTS_MAX_LIMIT);
  const rows = await db
    .select()
    .from(events)
    .where(gt(events.id, query.after))
    .orderBy(asc(events.id))
    .limit(cappedLimit);
  return rows.map(toEventView);
};