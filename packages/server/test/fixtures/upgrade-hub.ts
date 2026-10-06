/**
 * A hub as the start-up upgrade passes meet it (services/doc-upgrade.ts,
 * services/draft-link-cleanup.ts): an in-memory app, one developer with a
 * registered session, and — seeded straight through SQL, the way an older
 * hub left them — work contexts whose doc predates NORMALIZED_DOC_VERSION.
 * Bulk SQL rather than the ingest route, so a test can afford the thousands
 * of contexts a load bound needs.
 */
import { sql } from "drizzle-orm";

import { createDb, createServer } from "../../src/index.ts";
import type { Db, Embedder } from "../../src/index.ts";
import {
  createFakeClock,
  createTestDeveloper,
  registerTestSession,
  TEST_ADMIN_TOKEN,
  TEST_CI_TOKEN,
  TEST_WEBAUTHN_ORIGIN,
  VALID_SESSION_BODY,
} from "../helpers.ts";
import type { TestDeveloper, TestHarness } from "../helpers.ts";

export interface UpgradeHub {
  readonly harness: TestHarness;
  readonly nick: TestDeveloper;
}

export const inMemoryUpgradeHub = async (embedder: Embedder | null = null): Promise<UpgradeHub> => {
  const db: Db = await createDb();
  const clock = createFakeClock();
  const app = createServer({
    db,
    now: clock.now,
    adminToken: TEST_ADMIN_TOKEN,
    ciToken: TEST_CI_TOKEN,
    embedder,
    webauthnOrigins: [TEST_WEBAUTHN_ORIGIN],
    peerAddress: () => "127.0.0.1",
  });
  const harness = { app, clock, db };
  const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
  await registerTestSession(harness, nick.apiKey);
  return { harness, nick };
};

/**
 * `count` pre-round contexts `wc_000001…`, each with one vouched claim and —
 * when `withDraft` — one unreviewed draft, docs at version 0 still holding
 * the draft's words.
 */
export const seedPreRoundContexts = async (
  db: Db,
  count: number,
  options: { readonly withDraft?: boolean; readonly prefix?: string } = {},
): Promise<readonly string[]> => {
  const prefix = options.prefix ?? "wc_";
  const session = VALID_SESSION_BODY.id;
  await db.execute(sql`
    INSERT INTO work_contexts (id, session_id, title, description, status, normalized_doc, doc_version, created_at)
    SELECT ${prefix} || lpad(g::text, 6, '0'), ${session}, 'Context ' || g, 'nothing here', 'analyzing',
           'Context ' || g || E'\nanalyzing\nobservation: zebrafrobnicator guess ' || g, 0, now()
    FROM generate_series(1, ${count}) g`);
  await db.execute(sql`
    INSERT INTO claims (id, work_context_id, author_session_id, kind, body, status, confidence, capture_mode, provenance, created_at)
    SELECT 'clm_v_' || ${prefix} || g, ${prefix} || lpad(g::text, 6, '0'), ${session}, 'observation',
           'vouched finding ' || g, 'proposed', 0.9, 'agent', 'declared', now()
    FROM generate_series(1, ${count}) g`);
  if (options.withDraft !== false) {
    await db.execute(sql`
      INSERT INTO claims (id, work_context_id, author_session_id, kind, body, status, confidence, capture_mode, provenance, created_at)
      SELECT 'clm_d_' || ${prefix} || g, ${prefix} || lpad(g::text, 6, '0'), ${session}, 'hypothesis',
             'zebrafrobnicator guess ' || g, 'proposed', 0.4, 'auto', 'derived', now()
      FROM generate_series(1, ${count}) g`);
  }
  return Array.from({ length: count }, (_, i) => `${prefix}${String(i + 1).padStart(6, "0")}`);
};
