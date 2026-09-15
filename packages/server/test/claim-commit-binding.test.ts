/**
 * The database half of the claim ↔ code binding (1.0 spec 02 §3.1).
 *
 * Two columns, written ONCE at INSERT and never updated, and one CHECK that
 * makes "no commit means no binding" a database fact rather than a service
 * promise — the shape `questions_addressee_check` already uses. Without the
 * CHECK the two columns can disagree, and a claim carrying a commit under
 * `commit_binding = 'none'` would be surfaced as unbindable while a claim
 * with no commit under `'session_base'` would be surfaced as bound: AT-2's
 * first "fails if" clause, reachable from a single bad INSERT.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { createTestHarness } from "./helpers.ts";
import type { TestHarness } from "./helpers.ts";

const seedRows = async (harness: TestHarness): Promise<void> => {
  await harness.db.execute(
    sql`INSERT INTO developers (id, name, email, api_key_hash, created_at)
        VALUES ('dev_1', 'Nick', 'nick@example.com', 'hash_1', now())`,
  );
  await harness.db.execute(
    sql`INSERT INTO agent_sessions
          (id, developer_id, agent_kind, repo, branch, base_commit, status, started_at, last_heartbeat_at)
        VALUES ('ses_1', 'dev_1', 'claude-code', 'github.com/acme/api', 'main', 'a1b2c3d4', 'analyzing', now(), now())`,
  );
  await harness.db.execute(
    sql`INSERT INTO work_contexts (id, session_id, title, status, created_at)
        VALUES ('wc_1', 'ses_1', 'Login 500s', 'analyzing', now())`,
  );
};

/**
 * One claim row, straight past ingest.
 *
 * Awaited inside an async function rather than returned: drizzle hands back a
 * thenable that is not a Promise, and `expect(...).rejects` does not
 * recognise one.
 */
const insertClaim = async (
  harness: TestHarness,
  id: string,
  observedAtCommit: string | null,
  commitBinding: string,
): Promise<void> => {
  await harness.db.execute(
    sql`INSERT INTO claims
          (id, work_context_id, author_session_id, kind, body, status, confidence,
           capture_mode, provenance, evidence_refs, created_at,
           observed_at_commit, commit_binding)
        VALUES (${id}, 'wc_1', 'ses_1', 'observation', 'JWT validation fails',
                'proposed', 0.8, 'agent', 'declared', '[]'::jsonb, now(),
                ${observedAtCommit}, ${commitBinding})`,
  );
};

describe("claims commit binding", () => {
  test("a commit stored under binding 'none' is refused by the database", async () => {
    // Arrange
    const harness = await createTestHarness();
    await seedRows(harness);

    // Act + Assert: the two columns may not disagree in either direction.
    await expect(
      insertClaim(harness, "clm_bad_a", "a1b2c3d4", "none"),
    ).rejects.toThrow();
    await expect(
      insertClaim(harness, "clm_bad_b", null, "session_base"),
    ).rejects.toThrow();
    await expect(
      insertClaim(harness, "clm_bad_c", null, "reported"),
    ).rejects.toThrow();
  });

  test("the three legal shapes are accepted", async () => {
    // Arrange
    const harness = await createTestHarness();
    await seedRows(harness);

    // Act
    await insertClaim(harness, "clm_ok_none", null, "none");
    await insertClaim(harness, "clm_ok_session", "a1b2c3d4", "session_base");
    await insertClaim(harness, "clm_ok_reported", "ff00aa11bb", "reported");

    // Assert
    const result = (await harness.db.execute(
      sql`SELECT count(*)::int AS n FROM claims WHERE id LIKE 'clm_ok_%'`,
    )) as unknown as { readonly rows: readonly { readonly n: number }[] };
    expect(result.rows[0]?.n).toBe(3);
  });

  test("a claim inserted with neither column defaults to no binding", async () => {
    // Arrange: every claim written by a hub that predates this column, and
    // every claim an old connector still sends, has to land somewhere. It
    // lands on 'none' — fail closed on the code axis (non-negotiable #3).
    const harness = await createTestHarness();
    await seedRows(harness);

    // Act
    await harness.db.execute(
      sql`INSERT INTO claims
            (id, work_context_id, author_session_id, kind, body, status, confidence,
             capture_mode, provenance, evidence_refs, created_at)
          VALUES ('clm_default', 'wc_1', 'ses_1', 'observation', 'no binding',
                  'proposed', 0.8, 'agent', 'declared', '[]'::jsonb, now())`,
    );

    // Assert
    const result = (await harness.db.execute(
      sql`SELECT commit_binding, observed_at_commit FROM claims WHERE id = 'clm_default'`,
    )) as unknown as {
      readonly rows: readonly {
        readonly commit_binding: string;
        readonly observed_at_commit: string | null;
      }[];
    };
    expect(result.rows[0]?.commit_binding).toBe("none");
    expect(result.rows[0]?.observed_at_commit).toBeNull();
  });
});
