import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { SSEStreamingApi } from "hono/streaming";

import {
  EVENTS_MAX_LIMIT,
  POLL_INTERVAL_MS,
  SSE_KEEPALIVE_INTERVAL_MS,
} from "../constants.ts";
import { fail, ok } from "../http/envelope.ts";
import { formatIssues } from "../http/request.ts";
import { EventsQuerySchema } from "../http/schemas.ts";
import { developerAuth } from "../middleware/auth.ts";
import { listEventsAfter } from "../services/events.ts";
import type { EventView } from "../services/events.ts";
import type { AppDeps, AppEnv, Clock } from "../types.ts";

const SSE_KEEPALIVE_FRAME = ": keep-alive\n\n";

const parseEventCursor = (raw: string | undefined): number => {
  if (raw === undefined) {
    return 0;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
};

const writeEventFrame = async (
  stream: SSEStreamingApi,
  event: EventView,
): Promise<void> => {
  await stream.writeSSE({
    id: String(event.id),
    event: event.kind,
    data: JSON.stringify(event.payload),
  });
};

const maybeWriteKeepAlive = async (
  stream: SSEStreamingApi,
  now: Clock,
  lastKeepAliveMs: number,
): Promise<number> => {
  const nowMs = now().getTime();
  if (nowMs - lastKeepAliveMs < SSE_KEEPALIVE_INTERVAL_MS) {
    return lastKeepAliveMs;
  }
  await stream.write(SSE_KEEPALIVE_FRAME);
  return nowMs;
};

export const eventsRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();
  router.use("*", developerAuth(deps));

  router.get("/", async (c) => {
    const parsed = EventsQuerySchema.safeParse({
      after: c.req.query("after"),
      limit: c.req.query("limit"),
    });
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }

    const eventPage = await listEventsAfter(deps.db, parsed.data);
    return ok(c, { events: eventPage });
  });

  router.get("/stream", (c) =>
    streamSSE(
      c,
      async (stream) => {
        let cursor = parseEventCursor(c.req.header("Last-Event-ID"));
        let lastKeepAliveMs = deps.now().getTime();
        while (!stream.aborted) {
          const batch = await listEventsAfter(deps.db, {
            after: cursor,
            limit: EVENTS_MAX_LIMIT,
          });
          for (const event of batch) {
            await writeEventFrame(stream, event);
            cursor = event.id;
          }
          lastKeepAliveMs = await maybeWriteKeepAlive(
            stream,
            deps.now,
            lastKeepAliveMs,
          );
          const hasMoreToDrain = batch.length === EVENTS_MAX_LIMIT;
          if (!hasMoreToDrain) {
            await stream.sleep(POLL_INTERVAL_MS);
          }
        }
      },
      async (error) => {
        console.error("[crosscheck] sse stream error", error);
      },
    ),
  );

  return router;
};