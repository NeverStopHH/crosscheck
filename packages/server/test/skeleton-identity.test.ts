/**
 * THE SKELETON KNOWS WHICH FILE, WHICH VENDOR AND WHICH CONTEXT
 * (1.0 spec 01a §3.2, §3.3d, §4.1, §4.3 — CSK-15 (a), CSK-20 (a)).
 *
 * The retention graph joins a human's pin to a session's touch through ONE
 * value, `file_ref`, and it is only as good as the two writers agreeing. So
 * each case here asks both sides — the pin's history and the touch's row —
 * and compares the stored bytes, never a recomputation in the test.
 *
 * And the rows that predate the columns: the backfill fills what it can
 * reach from what the hub holds, and leaves NULL — unresolved, which the
 * sweep keeps — what it cannot. A backfill that reported zero unresolved rows
 * while one was unreachable would be the confident wrong answer.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { PIN_PRESENCE_TERMINAL, fileRef } from "@crosscheck/schema";

import { backfillSkeletonIdentity } from "../src/services/skeleton-identity.ts";
import {
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  TEST_START_ISO,
  validClaimBody,
  validClaimEdgeBody,
  validWorkContextBody,
  VALID_SESSION_BODY,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = VALID_SESSION_BODY.repo;
const OTHER_REPO = "github.com/acme/web";
const FILE = "src/x.ts";

interface World {
  readonly harness: TestHarness;
  readonly nick: TestDeveloper;
}

const world = async (): Promise<World> => {
  const harness = await createTestHarness();
  const nick = await createTestDeveloper(harness, "Nick", "nick-identity@example.com");
  expect((await registerTestSession(harness, nick.apiKey, { id: "ses_a" })).status).toBe(200);
  return { harness, nick };
};

const touch = async (
  { harness, nick }: World,
  contextId: string,
  files: readonly string[],
): Promise<void> => {
  const result = await postRecords(harness, nick, {
    records: [
      recordEnvelope(
        "work_context",
        validWorkContextBody({
          id: contextId,
          sessionId: "ses_a",
          title: "Playback",
          description: undefined,
          createdAt: TEST_START_ISO,
        }),
        { sessionId: "ses_a" },
      ),
      ...files.map((value) =>
        recordEnvelope(
          "target",
          { workContextId: contextId, kind: "file", value },
          { sessionId: "ses_a" },
        ),
      ),
    ],
  });
  expect(result.data?.rejected ?? -1).toBe(0);
};

/**
 * Two work contexts of one session, a claim in each, and the second claim
 * superseding the first — so the invalidation's row has two candidate
 * contexts and must take the invalidating one.
 */
const claimAndSupersede = async (w: World): Promise<void> => {
  await touch(w, "wc_old", []);
  await touch(w, "wc_new", []);
  const result = await postRecords(w.harness, w.nick, {
    records: [
      recordEnvelope(
        "claim",
        validClaimBody({ id: "clm_old", workContextId: "wc_old", authorSessionId: "ses_a" }),
        { sessionId: "ses_a" },
      ),
      recordEnvelope(
        "claim",
        validClaimBody({ id: "clm_new", workContextId: "wc_new", authorSessionId: "ses_a" }),
        { sessionId: "ses_a" },
      ),
      recordEnvelope(
        "claim_edge",
        validClaimEdgeBody({
          id: "edge_sup",
          fromClaimId: "clm_new",
          toClaimId: "clm_old",
          kind: "supersedes",
          authorSessionId: "ses_a",
        }),
        { sessionId: "ses_a" },
      ),
    ],
  });
  expect(result.data?.rejected ?? -1).toBe(0);
};

const pin = async (
  { harness, nick }: World,
  id: string,
  files: readonly string[],
  repo: string = REPO,
): Promise<void> => {
  const response = await harness.app.request(
    "/api/pins",
    jsonRequest("POST", nick.apiKey, {
      id,
      repo,
      surface: "Play button plays/pauses",
      files,
      check: "open /workbench, press Play",
      presence: PIN_PRESENCE_TERMINAL,
      verifiedAtCommit: "abc1234",
    }),
  );
  expect(response.status).toBe(200);
};

const rows = async (
  harness: TestHarness,
  query: SQL,
): Promise<readonly Record<string, unknown>[]> =>
  (await harness.db.execute(query)).rows as Record<string, unknown>[];

const touchRefs = (harness: TestHarness) =>
  rows(harness, sql`SELECT file_ref FROM session_events WHERE kind = 'file.modified' ORDER BY file_ref`);

const pinRefs = (harness: TestHarness, pinId: string) =>
  rows(
    harness,
    sql`SELECT file_ref, unresolved_reason FROM pin_file_refs WHERE pin_id = ${pinId} ORDER BY file_ref NULLS FIRST`,
  );

const deps = (harness: TestHarness) => ({ db: harness.db, now: harness.clock.now });

describe("the skeleton row carries its own identity", () => {
  test("a touch's row names its vendor, its work context and its file", async () => {
    // Arrange
    const w = await world();

    // Act — spelled the way a connector that is not ours might send it
    await touch(w, "wc_a", [`./${FILE}`]);

    // Assert
    expect(
      await rows(
        w.harness,
        sql`SELECT kind, provider, work_context_id, file_ref FROM session_events ORDER BY kind`,
      ),
    ).toEqual([
      { kind: "file.modified", provider: "claude-code", work_context_id: "wc_a", file_ref: fileRef(REPO, FILE) },
      { kind: "session.started", provider: "claude-code", work_context_id: null, file_ref: null },
    ]);
  });

  test("a claim's row names its claim's context; an invalidation names the invalidating claim's", async () => {
    // Arrange & Act
    const w = await world();
    await claimAndSupersede(w);

    // Assert
    expect(
      await rows(
        w.harness,
        sql`SELECT kind, ref_id, work_context_id FROM session_events WHERE kind LIKE 'claim.%' ORDER BY kind, ref_id`,
      ),
    ).toEqual([
      { kind: "claim.created", ref_id: "clm_new", work_context_id: "wc_new" },
      { kind: "claim.created", ref_id: "clm_old", work_context_id: "wc_old" },
      { kind: "claim.invalidated", ref_id: "edge_sup", work_context_id: "wc_new" },
    ]);
  });

  test("a pin typed ./src/x.ts and a session that edited src/x.ts hold one identity", async () => {
    // Arrange
    const w = await world();
    await touch(w, "wc_a", [FILE]);

    // Act
    await pin(w, "pin_a", [`./${FILE}`]);

    // Assert — the bytes both writers stored, compared to each other
    const [touched] = await touchRefs(w.harness);
    expect(await pinRefs(w.harness, "pin_a")).toEqual([
      { file_ref: touched?.["file_ref"], unresolved_reason: null },
    ]);
  });

  test("a repo identity no file identity can be computed from is unresolved, not a failure", async () => {
    // Arrange & Act — a raw client's repo carries the identity's separator
    const w = await world();
    await pin(w, "pin_bad_repo", [FILE], "github.com/acme\napi");

    // Assert — stored, and marked unresolved with its reason
    expect(await pinRefs(w.harness, "pin_bad_repo")).toEqual([
      { file_ref: null, unresolved_reason: "repo_not_canonical" },
    ]);
  });

  test("the same path in another repo is another file", async () => {
    // Arrange
    const w = await world();
    await touch(w, "wc_a", [FILE]);

    // Act
    await pin(w, "pin_web", [FILE], OTHER_REPO);

    // Assert
    const [touched] = await touchRefs(w.harness);
    const [pinned] = await pinRefs(w.harness, "pin_web");
    expect(pinned?.["file_ref"]).toBe(fileRef(OTHER_REPO, FILE));
    expect(pinned?.["file_ref"]).not.toBe(touched?.["file_ref"]);
  });

  test("a rename adds the new identity and keeps the old one", async () => {
    // Arrange
    const w = await world();
    await pin(w, "pin_a", [FILE]);

    // Act — the sweep records the weekly rename
    const swept = await w.harness.app.request(
      "/api/pins/sweep",
      jsonRequest("POST", w.nick.apiKey, {
        repo: REPO,
        updates: [{ pinId: "pin_a", path: FILE, newPath: "src/y.ts" }],
      }),
    );

    // Assert — pin_files holds the current name, the history holds both
    expect(swept.status).toBe(200);
    expect(
      await rows(w.harness, sql`SELECT path FROM pin_files WHERE pin_id = 'pin_a'`),
    ).toEqual([{ path: "src/y.ts" }]);
    expect((await pinRefs(w.harness, "pin_a")).map((row) => row["file_ref"]).sort()).toEqual(
      [fileRef(REPO, FILE), fileRef(REPO, "src/y.ts")].sort(),
    );
  });
});

describe("the backfill of rows that predate the columns", () => {
  const forgetIdentity = async (harness: TestHarness): Promise<void> => {
    await harness.db.execute(
      sql`UPDATE session_events SET provider = NULL, work_context_id = NULL, file_ref = NULL`,
    );
    await harness.db.execute(sql`DELETE FROM pin_file_refs`);
  };

  const identities = (harness: TestHarness) =>
    rows(harness, sql`SELECT id, provider, work_context_id, file_ref FROM session_events ORDER BY id`);

  test("fills every identity the hub can reach, as the live writers would have", async () => {
    // Arrange — written complete, captured, then forgotten
    const w = await world();
    await touch(w, "wc_a", [FILE, "src/z.ts"]);
    await claimAndSupersede(w);
    await pin(w, "pin_a", [FILE]);
    const complete = await identities(w.harness);
    const history = await pinRefs(w.harness, "pin_a");
    await forgetIdentity(w.harness);

    // Act
    const report = await backfillSkeletonIdentity(deps(w.harness));

    // Assert — byte for byte what the live path wrote
    expect(await identities(w.harness)).toEqual(complete);
    expect(await pinRefs(w.harness, "pin_a")).toEqual(history);
    expect(report).toEqual({
      pinPathsCanonicalised: 0,
      pinsSeeded: 1,
      // session.started, two file.modified, two claim.created, one claim.invalidated
      providers: 6,
      workContexts: 5,
      fileRefs: 2,
      unresolvedFileRefs: 0,
    });
  });

  test("the backfill walks page by page and reaches the same values at any page size", async () => {
    // Arrange — more rows than a page, so every loop has to turn its cursor
    const w = await world();
    await touch(w, "wc_a", [FILE, "src/z.ts", "src/q.ts"]);
    await claimAndSupersede(w);
    const complete = await identities(w.harness);

    for (const batch of [1, 2]) {
      await forgetIdentity(w.harness);

      // Act
      const report = await backfillSkeletonIdentity(deps(w.harness), { batch });

      // Assert
      expect(await identities(w.harness), `page size ${String(batch)}`).toEqual(complete);
      expect(report.providers, `page size ${String(batch)}`).toBe(complete.length);
    }
  });

  test("a row it cannot resolve stays NULL and is counted, never guessed", async () => {
    // Arrange — a file.modified row whose target this hub does not hold
    const w = await world();
    await touch(w, "wc_a", [FILE]);
    await w.harness.db.execute(sql`
      INSERT INTO session_events (id, session_id, kind, seq_kind, seq_reason, ref_kind, ref_id, observed_at)
      VALUES ('se_orphan', 'ses_a', 'file.modified', 'observed', 'pre_seq_connector',
              'target_digest', ${"f".repeat(64)}, now())`);
    await forgetIdentity(w.harness);

    // Act
    const report = await backfillSkeletonIdentity(deps(w.harness));

    // Assert
    expect(report.unresolvedFileRefs).toBe(1);
    expect(
      await rows(w.harness, sql`SELECT file_ref FROM session_events WHERE id = 'se_orphan'`),
    ).toEqual([{ file_ref: null }]);
  });

  test("a legacy pin that was renamed carries the unresolved marker", async () => {
    // Arrange — the names it watched before the rename are gone from pin_files
    const w = await world();
    await pin(w, "pin_a", [FILE]);
    await forgetIdentity(w.harness);
    await w.harness.db.execute(sql`UPDATE pins SET renamed_paths = 1 WHERE id = 'pin_a'`);

    // Act
    await backfillSkeletonIdentity(deps(w.harness));

    // Assert
    expect(await pinRefs(w.harness, "pin_a")).toEqual([
      { file_ref: null, unresolved_reason: "rename_history_unrecorded" },
      { file_ref: fileRef(REPO, FILE), unresolved_reason: null },
    ]);
  });

  test("a pin stored before the door takes the one spelling, so a touch still meets it", async () => {
    // Arrange — a pin row as an older hub stored it, verbatim, and a touch the
    // new hub canonicalised at ingest
    const w = await world();
    await pin(w, "pin_dotted", [FILE]);
    await w.harness.db.execute(sql`UPDATE pin_files SET path = ${`./${FILE}`} WHERE pin_id = 'pin_dotted'`);
    await touch(w, "wc_a", [FILE]);

    // Act
    const report = await backfillSkeletonIdentity(deps(w.harness));

    // Assert — the exact-string intersection `suspect` runs now meets
    expect(report.pinPathsCanonicalised).toBe(1);
    expect(
      await rows(
        w.harness,
        sql`SELECT pf.path FROM pin_files pf
              JOIN work_context_targets t ON t.value = pf.path AND t.kind = 'file'
             WHERE pf.pin_id = 'pin_dotted'`,
      ),
    ).toEqual([{ path: FILE }]);
  });

  test("a partial history is completed, file by file", async () => {
    // Arrange — a pin with two files whose history lost one of them (a
    // failed seed, then a rename): "has some history" is not "is resolved"
    const w = await world();
    await pin(w, "pin_two", [FILE, "src/y.ts"]);
    await w.harness.db.execute(
      sql`DELETE FROM pin_file_refs WHERE pin_id = 'pin_two' AND file_ref = ${fileRef(REPO, "src/y.ts")}`,
    );

    // Act
    const report = await backfillSkeletonIdentity(deps(w.harness));

    // Assert
    expect(report.pinsSeeded).toBe(1);
    expect((await pinRefs(w.harness, "pin_two")).map((row) => row["file_ref"]).sort()).toEqual(
      [fileRef(REPO, FILE), fileRef(REPO, "src/y.ts")].sort(),
    );
  });

  test("a rename keeps the name it leaves, even on a pin with no history yet", async () => {
    // Arrange — a pin from before the table, renamed before the seed ran
    const w = await world();
    await pin(w, "pin_legacy", [FILE]);
    await w.harness.db.execute(sql`DELETE FROM pin_file_refs WHERE pin_id = 'pin_legacy'`);

    // Act
    const swept = await w.harness.app.request(
      "/api/pins/sweep",
      jsonRequest("POST", w.nick.apiKey, {
        repo: REPO,
        updates: [{ pinId: "pin_legacy", path: FILE, newPath: "src/renamed.ts" }],
      }),
    );

    // Assert — both names, so the sessions that touched the old one stay reachable
    expect(swept.status).toBe(200);
    expect((await pinRefs(w.harness, "pin_legacy")).map((row) => row["file_ref"]).sort()).toEqual(
      [fileRef(REPO, FILE), fileRef(REPO, "src/renamed.ts")].sort(),
    );
  });

  test("a second run finds nothing to do", async () => {
    // Arrange
    const w = await world();
    await touch(w, "wc_a", [FILE]);
    await pin(w, "pin_a", [FILE]);
    await forgetIdentity(w.harness);
    await backfillSkeletonIdentity(deps(w.harness));

    // Act
    const again = await backfillSkeletonIdentity(deps(w.harness));

    // Assert
    expect(again).toEqual({
      pinPathsCanonicalised: 0,
      pinsSeeded: 0,
      providers: 0,
      workContexts: 0,
      fileRefs: 0,
      unresolvedFileRefs: 0,
    });
  });
});

/**
 * CSK-10 — NO TEXT REACHES THE SKELETON. Every content field this build
 * touches carries a marker; the skeleton's tables are then searched byte for
 * byte. A file identity is a HASH of the path, so the path itself must be
 * nowhere in them — the one place a copy of content would be easiest to slip
 * in "for convenience".
 */
describe("the skeleton holds no text (CSK-10)", () => {
  test("no marker planted in content appears in session_events or pin_file_refs", async () => {
    // Arrange
    const MARK = "csk10-marker";
    const w = await world();
    const result = await postRecords(w.harness, w.nick, {
      records: [
        recordEnvelope(
          "work_context",
          validWorkContextBody({
            id: "wc_marked",
            sessionId: "ses_a",
            title: `${MARK} title`,
            description: `${MARK} description`,
            createdAt: TEST_START_ISO,
          }),
          { sessionId: "ses_a" },
        ),
        recordEnvelope(
          "target",
          { workContextId: "wc_marked", kind: "file", value: `src/${MARK}-path.ts` },
          { sessionId: "ses_a" },
        ),
        recordEnvelope(
          "claim",
          validClaimBody({
            id: "clm_marked",
            workContextId: "wc_marked",
            authorSessionId: "ses_a",
            body: `${MARK} claim body`,
          }),
          { sessionId: "ses_a" },
        ),
      ],
    });
    expect(result.data?.rejected ?? -1).toBe(0);
    const pinned = await w.harness.app.request(
      "/api/pins",
      jsonRequest("POST", w.nick.apiKey, {
        id: "pin_marked",
        repo: REPO,
        surface: `${MARK} surface`,
        files: [`src/${MARK}-path.ts`],
        check: `${MARK} check`,
        presence: PIN_PRESENCE_TERMINAL,
        verifiedAtCommit: "abc1234",
      }),
    );
    expect(pinned.status).toBe(200);

    // Act
    const skeleton = await rows(
      w.harness,
      sql`SELECT row_to_json(t)::text AS j FROM session_events t
          UNION ALL SELECT row_to_json(r)::text FROM pin_file_refs r`,
    );

    // Assert — the rows exist, and none carries the marker
    expect(skeleton.length).toBeGreaterThanOrEqual(4);
    expect(skeleton.map((row) => String(row["j"])).join("\n")).not.toContain(MARK);
  });
});

