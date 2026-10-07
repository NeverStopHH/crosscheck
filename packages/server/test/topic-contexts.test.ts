/**
 * TOPIC CONTEXTS, ON THE HUB (DESIGN.md "One session, many topics").
 *
 * A connector that captures one session across several sibling worktrees
 * sends one work context per (repo, branch) it touched, each naming its
 * branch and the commit HEAD named at the session's first touch. The hub
 * takes them ADDITIVELY: a session may own several contexts — it always could
 * — and a context from a connector before topics, carrying neither field,
 * ingests and reads exactly as it always has.
 */
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

import { workContexts } from "../src/db/schema.ts";
import { BOOTSTRAP_SQL_URL } from "./fixtures/bootstrap-sql.ts";
import {
  VALID_SESSION_BODY,
  WORK_CONTEXT_ID,
  createHarnessWithSession,
  jsonRequest,
  postRecords,
  recordEnvelope,
  validWorkContextBody,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const TOPIC_A = `${WORK_CONTEXT_ID}~t0a1b2c3d4e5f`;
const TOPIC_B = `${WORK_CONTEXT_ID}~tf5e4d3c2b1a0`;
const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);

const topicBody = (id: string, branch: string, baseCommit: string): Record<string, unknown> =>
  validWorkContextBody({ id, title: `${branch} @ api`, status: "implementing", branch, baseCommit });

const target = (workContextId: string, value: string): Record<string, unknown> =>
  recordEnvelope("target", { workContextId, kind: "file", value });

interface DiagnosisView {
  readonly baseCommit: string;
  readonly branch: string | null;
}

const diagnosisOf = async (
  harness: TestHarness,
  developer: TestDeveloper,
  workContextId: string,
): Promise<DiagnosisView> => {
  const response = await harness.app.request(
    `/api/work-contexts/${encodeURIComponent(workContextId)}/diagnosis`,
    jsonRequest("GET", developer.apiKey),
  );
  const body = (await response.json()) as { data: { workContext: DiagnosisView } };
  return body.data.workContext;
};

const storedTopic = async (
  harness: TestHarness,
  id: string,
): Promise<{ readonly branch: string | null; readonly baseCommit: string | null } | undefined> =>
  (
    await harness.db
      .select({ branch: workContexts.branch, baseCommit: workContexts.baseCommit })
      .from(workContexts)
      .where(eq(workContexts.id, id))
  )[0];

describe("an older connector's one context per session", () => {
  test("ingests unchanged, and reads the session's own base commit", async () => {
    // Arrange
    const { harness, developer } = await createHarnessWithSession();

    // Act
    const posted = await postRecords(harness, developer, {
      records: [recordEnvelope("work_context", validWorkContextBody()), target(WORK_CONTEXT_ID, "src/a.ts")],
    });

    // Assert
    expect(posted.data?.accepted).toBe(2);
    expect(await storedTopic(harness, WORK_CONTEXT_ID)).toEqual({ branch: null, baseCommit: null });
    expect(await diagnosisOf(harness, developer, WORK_CONTEXT_ID)).toMatchObject({
      baseCommit: VALID_SESSION_BODY.baseCommit,
      branch: null,
    });
  });
});

describe("a session's topic contexts", () => {
  test("ingest beside the session's own, each with its branch, base commit and targets", async () => {
    // Arrange
    const { harness, developer } = await createHarnessWithSession();

    // Act: the session's own context, then two topics, each ahead of its targets
    const posted = await postRecords(harness, developer, {
      records: [
        recordEnvelope("work_context", validWorkContextBody()),
        recordEnvelope("work_context", topicBody(TOPIC_A, "feat/topic-a", COMMIT_A)),
        target(TOPIC_A, "src/a.ts"),
        recordEnvelope("work_context", topicBody(TOPIC_B, "feat/topic-b", COMMIT_B)),
        target(TOPIC_B, "src/a.ts"),
      ],
    });

    // Assert: everything taken — the same path is two topics' touch, not a duplicate
    expect(posted.data?.accepted).toBe(5);
    expect(await diagnosisOf(harness, developer, TOPIC_A)).toMatchObject({ baseCommit: COMMIT_A, branch: "feat/topic-a" });
    expect(await diagnosisOf(harness, developer, TOPIC_B)).toMatchObject({ baseCommit: COMMIT_B, branch: "feat/topic-b" });
    const sessions = await harness.db.execute(
      sql`SELECT count(*)::int AS n FROM work_contexts WHERE session_id = ${VALID_SESSION_BODY.id}`,
    );
    expect(sessions.rows[0]?.n).toBe(3);
  });

  test("a copy without the topic fields keeps them, and a later topic never moves them", async () => {
    // Arrange: the topic as its own first copy carried it
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(harness, developer, {
      records: [recordEnvelope("work_context", topicBody(TOPIC_A, "feat/topic-a", COMMIT_A))],
    });

    // Act: a re-send that carries neither field, then one naming another branch
    const bare = validWorkContextBody({ id: TOPIC_A, title: "feat/topic-a @ api", status: "testing" });
    await postRecords(harness, developer, { records: [recordEnvelope("work_context", bare)] });
    const moved = await storedTopic(harness, TOPIC_A);
    await postRecords(harness, developer, {
      records: [recordEnvelope("work_context", topicBody(TOPIC_A, "feat/elsewhere", COMMIT_B))],
    });

    // Assert
    expect(moved).toEqual({ branch: "feat/topic-a", baseCommit: COMMIT_A });
    expect(await storedTopic(harness, TOPIC_A)).toEqual({ branch: "feat/topic-a", baseCommit: COMMIT_A });
  });

  test("a context that had none is filled by the first copy that carries them", async () => {
    // Arrange
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(harness, developer, {
      records: [recordEnvelope("work_context", validWorkContextBody({ id: TOPIC_A }))],
    });

    // Act
    await postRecords(harness, developer, {
      records: [recordEnvelope("work_context", topicBody(TOPIC_A, "feat/topic-a", COMMIT_A))],
    });

    // Assert
    expect(await storedTopic(harness, TOPIC_A)).toEqual({ branch: "feat/topic-a", baseCommit: COMMIT_A });
  });

  test("a base commit that is no object name is refused at the schema", async () => {
    // Arrange
    const { harness, developer } = await createHarnessWithSession();

    // Act
    const posted = await postRecords(harness, developer, {
      records: [recordEnvelope("work_context", topicBody(TOPIC_A, "feat/topic-a", "not-a-sha"))],
    });

    // Assert
    expect(posted.data?.rejected).toBe(1);
  });
});

describe("bootstrap.sql DDL sync — a topic's branch and base commit", () => {
  test("both columns are in both DDL sources and nullable after a bootstrap", async () => {
    // Arrange
    const bootstrapSql = await Bun.file(BOOTSTRAP_SQL_URL).text();
    const columns = getTableConfig(workContexts).columns;
    const harness = (await createHarnessWithSession()).harness;

    // Act
    const rows = await harness.db.execute(
      sql`SELECT column_name AS c, is_nullable AS n FROM information_schema.columns
          WHERE table_name = 'work_contexts' AND column_name IN ('branch', 'base_commit') ORDER BY column_name`,
    );

    // Assert
    expect(bootstrapSql).toContain("ALTER TABLE work_contexts ADD COLUMN IF NOT EXISTS branch text;");
    expect(bootstrapSql).toContain("ALTER TABLE work_contexts ADD COLUMN IF NOT EXISTS base_commit text;");
    expect(columns.find((column) => column.name === "branch")?.notNull).toBe(false);
    expect(columns.find((column) => column.name === "base_commit")?.notNull).toBe(false);
    expect(rows.rows.map((row) => [row.c, row.n])).toEqual([
      ["base_commit", "YES"],
      ["branch", "YES"],
    ]);
  });
});
