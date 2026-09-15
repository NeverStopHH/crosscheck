/**
 * INGEST STAMPS THE BINDING — the only writer of `claims.observed_at_commit`
 * and `claims.commit_binding` (1.0 spec 02 §3.1).
 *
 * Three cases, and the third is the one a spec written from the table shapes
 * alone misses: `agent_sessions.base_commit` is `text NOT NULL` with a wire
 * schema of `z.string().min(1)`, so ANY non-empty string is stored — and
 * `crosscheck conference` registers its session with the literal
 * "conference". A fallback that trusted the column would hand that to
 * `git rev-list` as an object name.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import {
  createHarnessWithSession,
  postRecords,
  recordEnvelope,
  validClaimBody,
  validWorkContextBody,
} from "./helpers.ts";
import type { TestHarness } from "./helpers.ts";

interface StoredBinding {
  readonly observedAtCommit: string | null;
  readonly commitBinding: string;
}

const readBinding = async (
  harness: TestHarness,
  claimId: string,
): Promise<StoredBinding | undefined> => {
  const result = (await harness.db.execute(
    sql`SELECT observed_at_commit, commit_binding FROM claims WHERE id = ${claimId}`,
  )) as unknown as {
    readonly rows: readonly {
      readonly observed_at_commit: string | null;
      readonly commit_binding: string;
    }[];
  };
  const row = result.rows[0];
  return row === undefined
    ? undefined
    : {
        observedAtCommit: row.observed_at_commit,
        commitBinding: row.commit_binding,
      };
};

describe("claim ingest stamps a commit binding", () => {
  test("a commit on the wire is stored as a reported binding", async () => {
    // Arrange
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(harness, developer, {
      records: [recordEnvelope("work_context", validWorkContextBody())],
    });

    // Act
    const posted = await postRecords(
      harness,
      developer,
      recordEnvelope(
        "claim",
        validClaimBody({ id: "clm_reported", observedAtCommit: "deadbee" }),
      ),
    );

    // Assert
    expect(posted.data?.accepted).toBe(1);
    expect(await readBinding(harness, "clm_reported")).toEqual({
      observedAtCommit: "deadbee",
      commitBinding: "reported",
    });
  });

  test("no commit on the wire falls back to the author session's base commit", async () => {
    // Arrange: VALID_SESSION_BODY registers with baseCommit "a1b2c3d4".
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(harness, developer, {
      records: [recordEnvelope("work_context", validWorkContextBody())],
    });

    // Act
    await postRecords(
      harness,
      developer,
      recordEnvelope("claim", validClaimBody({ id: "clm_session" })),
    );

    // Assert
    expect(await readBinding(harness, "clm_session")).toEqual({
      observedAtCommit: "a1b2c3d4",
      commitBinding: "session_base",
    });
  });

  test("a base commit that is not an object name binds to nothing", async () => {
    // Arrange: `crosscheck conference` registers its session with the literal
    // "conference" (cli/src/cli/conference.ts) and the placeholder
    // NO_COMMIT_SHA is "0000000" — neither is a sha, and neither may reach
    // `git rev-list` as an object name.
    const { harness, developer } = await createHarnessWithSession({
      baseCommit: "conference",
    });
    await postRecords(harness, developer, {
      records: [recordEnvelope("work_context", validWorkContextBody())],
    });

    // Act
    await postRecords(
      harness,
      developer,
      recordEnvelope("claim", validClaimBody({ id: "clm_label" })),
    );

    // Assert
    expect(await readBinding(harness, "clm_label")).toEqual({
      observedAtCommit: null,
      commitBinding: "none",
    });
  });

  test("the NO_COMMIT_SHA placeholder binds to nothing", async () => {
    // Arrange
    const { harness, developer } = await createHarnessWithSession({
      baseCommit: "0000000",
    });
    await postRecords(harness, developer, {
      records: [recordEnvelope("work_context", validWorkContextBody())],
    });

    // Act
    await postRecords(
      harness,
      developer,
      recordEnvelope("claim", validClaimBody({ id: "clm_placeholder" })),
    );

    // Assert
    expect(await readBinding(harness, "clm_placeholder")).toEqual({
      observedAtCommit: null,
      commitBinding: "none",
    });
  });

  test("a prose-shaped observedAtCommit is refused at the wire schema", async () => {
    // Arrange: nothing flag- or prose-shaped may reach git or SQL — the
    // landed-evidence rule, on the same hoisted COMMIT_SHA_PATTERN.
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(harness, developer, {
      records: [recordEnvelope("work_context", validWorkContextBody())],
    });

    // Act
    const posted = await postRecords(
      harness,
      developer,
      recordEnvelope(
        "claim",
        validClaimBody({
          id: "clm_prose",
          observedAtCommit: "--output=/tmp/pwned",
        }),
      ),
    );

    // Assert
    expect(posted.data?.rejected).toBe(1);
    expect(await readBinding(harness, "clm_prose")).toBeUndefined();
  });
});
