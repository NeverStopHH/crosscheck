import { Hono } from "hono";

import { MAX_INGEST_BATCH } from "../constants.ts";
import { fail, ok } from "../http/envelope.ts";
import { readJsonBody } from "../http/request.ts";
import { developerAuth } from "../middleware/auth.ts";
import { ingestRecords } from "../services/records.ts";
import type { AppDeps, AppEnv } from "../types.ts";

/** Accepts `{records: [...]}` or a single bare envelope as a batch of one. */
const toRecordBatch = (body: unknown): readonly unknown[] | null => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const records = (body as Record<string, unknown>)["records"];
  if (records === undefined) {
    return [body];
  }
  return Array.isArray(records) ? records : null;
};

export const recordsRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();
  router.use("*", developerAuth(deps));

  router.post("/", async (c) => {
    const batch = toRecordBatch(await readJsonBody(c));
    if (batch === null) {
      return fail(
        c,
        400,
        "validation_failed",
        "body must be {records: [...]} or a single record envelope",
      );
    }
    if (batch.length > MAX_INGEST_BATCH) {
      return fail(
        c,
        422,
        "batch_too_large",
        `a batch may contain at most ${MAX_INGEST_BATCH} records`,
      );
    }

    const developer = c.get("developer");
    const summary = await ingestRecords(deps, developer.id, batch);
    return ok(c, summary);
  });

  return router;
};