/**
 * THE SKELETON SWEEP (1.0 spec 01a §3.3 — CSK-1, 3, 11, 15, 16, 17, 18, 20,
 * 21, 22, 23, 26, 28).
 *
 * "Retention requires positive proof to delete, not positive proof to keep."
 * Every case below is one way a sweep could delete on something other than
 * proof: a root it forgot, a reference it could not resolve, a session it only
 * inferred had ended, a check that failed and read as "nothing references
 * this", or half a session. Each is seeded so that the ONE thing under test is
 * all that keeps the session — and the control beside it shows the same
 * session without that thing going, so a sweep that deletes nothing at all
 * cannot pass this file.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { PIN_PRESENCE_TERMINAL } from "@crosscheck/schema";
import type { RetentionRootName } from "@crosscheck/schema";

import { SESSION_EVENT_RETENTION_DAYS, SESSION_REAP_STALE_HOURS } from "../src/constants.ts";
import { RETENTION_REGISTRY, retentionRoots } from "../src/services/retention-registry.ts";
import type { RetentionRelation } from "../src/services/retention-registry.ts";
import {
  readSkeletonRetentionReport,
  sweepLedger,
  sweepSkeleton,
} from "../src/services/retention.ts";
import type { SweepOptions } from "../src/services/retention.ts";
import { endSession, reapStaleSessions } from "../src/services/sessions.ts";
import {
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  TEST_START_ISO,
  validClaimBody,
  validWorkContextBody,
  VALID_SESSION_BODY,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = VALID_SESSION_BODY.repo;
const OTHER_REPO = "github.com/acme/web";
const DAY_SECONDS = 24 * 60 * 60;
const HOUR_SECONDS = 60 * 60;
const FULL: SweepOptions = { mode: "full" };

interface World {
  readonly harness: TestHarness;
  readonly nick: TestDeveloper;
}

const world = async (): Promise<World> => {
  const harness = await createTestHarness();
  const nick = await createTestDeveloper(harness, "Nick", "nick-sweep@example.com");
  return { harness, nick };
};

const deps = (w: World) => ({ db: w.harness.db, now: w.harness.clock.now });

const rows = async (w: World, query: SQL): Promise<readonly Record<string, unknown>[]> =>
  (await w.harness.db.execute(query)).rows as Record<string, unknown>[];

const rowsOf = async (w: World, sessionId: string): Promise<number> =>
  Number(
    (await rows(w, sql`SELECT count(*)::int AS n FROM session_events WHERE session_id = ${sessionId}`))[0]?.["n"],
  );

const post = async (w: World, sessionId: string, records: readonly unknown[]): Promise<void> => {
  const result = await postRecords(w.harness, w.nick, { records });
  expect(result.data?.rejected ?? -1, `records for ${sessionId}`).toBe(0);
};

/** A registered session with its own work context and, optionally, file touches. */
const started = async (
  w: World,
  sessionId: string,
  files: readonly string[] = [],
  repo: string = REPO,
): Promise<void> => {
  expect((await registerTestSession(w.harness, w.nick.apiKey, { id: sessionId, repo })).status).toBe(200);
  await post(w, sessionId, [
    recordEnvelope(
      "work_context",
      validWorkContextBody({
        id: `wc_${sessionId}`,
        sessionId,
        title: "Playback",
        description: undefined,
        createdAt: TEST_START_ISO,
      }),
      { sessionId },
    ),
    ...files.map((value) =>
      recordEnvelope("target", { workContextId: `wc_${sessionId}`, kind: "file", value }, { sessionId }),
    ),
  ]);
};

const ended = async (w: World, sessionId: string): Promise<void> => {
  await endSession(deps(w), w.nick.developerId, sessionId);
};

/** Started and ended explicitly; `age` then takes it past the window. */
const endedSession = async (
  w: World,
  sessionId: string,
  files: readonly string[] = [],
  repo: string = REPO,
): Promise<void> => {
  await started(w, sessionId, files, repo);
  await ended(w, sessionId);
};

const age = (w: World, days = SESSION_EVENT_RETENTION_DAYS + 1): void => {
  w.harness.clock.advanceSeconds(days * DAY_SECONDS);
};

const pin = async (w: World, id: string, files: readonly string[]): Promise<void> => {
  const response = await w.harness.app.request(
    "/api/pins",
    jsonRequest("POST", w.nick.apiKey, {
      id,
      repo: REPO,
      surface: "Play button plays/pauses",
      files,
      check: "open /workbench, press Play",
      presence: PIN_PRESENCE_TERMINAL,
      verifiedAtCommit: "abc1234",
    }),
  );
  expect(response.status).toBe(200);
};

const claimIn = (sessionId: string, id: string) =>
  recordEnvelope(
    "claim",
    validClaimBody({
      id,
      workContextId: `wc_${sessionId}`,
      authorSessionId: sessionId,
      // Each claim its own statement: identical bodies are one claim to ingest.
      body: `Playback resumes after a seek (${id})`,
    }),
    { sessionId },
  );

describe("what the sweep removes", () => {
  test("a session nothing reaches is swept whole; one inside the window is not (CSK-3)", async () => {
    // Arrange — ses_old ends 31 days before the sweep, ses_recent 29
    const w = await world();
    await endedSession(w, "ses_old");
    age(w, 2);
    await endedSession(w, "ses_recent");
    const recentRows = await rowsOf(w, "ses_recent");
    age(w, SESSION_EVENT_RETENTION_DAYS - 1);

    // Act
    const outcome = await sweepSkeleton(deps(w));

    // Assert — every row of the one, not one row of the other
    expect(await rowsOf(w, "ses_old")).toBe(0);
    expect(await rowsOf(w, "ses_recent")).toBe(recentRows);
    expect(outcome).toEqual({ kind: "swept", sessions: 1, rows: 2 });
    expect(await readSkeletonRetentionReport(deps(w))).toMatchObject({ aged: 1, swept: 1 });
    // A swept session is done: its agent_sessions row stays for ever, and a
    // candidate list that still counted it would fill every later window
    // with sessions that have nothing left to retire
    await sweepSkeleton(deps(w));
    expect(await readSkeletonRetentionReport(deps(w))).toMatchObject({ aged: 0, swept: 0 });
  });

  test("a work context alone does not retain (CSK-16)", async () => {
    // Arrange — every session has one; belonging is not dependence
    const w = await world();
    await endedSession(w, "ses_wc");
    age(w);
    expect(await rows(w, sql`SELECT id FROM work_contexts WHERE session_id = 'ses_wc'`)).toHaveLength(1);

    // Act
    await sweepSkeleton(deps(w));

    // Assert
    expect(await rowsOf(w, "ses_wc")).toBe(0);
  });

  test("a session is decided by when it ended, never by a row's age (CSK-21)", async () => {
    // Arrange — ses_late ended past the window but holds a row written today;
    // ses_long ended inside the window, its rows older than the window
    const w = await world();
    await endedSession(w, "ses_late");
    await started(w, "ses_long");
    age(w);
    await ended(w, "ses_long");
    await w.harness.db.execute(sql`
      INSERT INTO session_events (id, session_id, kind, seq_kind, seq_reason, ref_kind, ref_id, observed_at)
      VALUES ('se_fresh', 'ses_late', 'commit.observed', 'observed', 'pre_seq_connector', 'session', 'ses_late', ${w.harness.clock.now()})`);

    // Act
    await sweepSkeleton(deps(w));

    // Assert — all or nothing, by the session's end
    expect(await rowsOf(w, "ses_late")).toBe(0);
    expect(await rowsOf(w, "ses_long")).toBeGreaterThan(0);
  });

  test("a file-bearing session nothing pins goes in full mode, and stays in interim", async () => {
    // Arrange — the control for every pin case: resolved, unpinned
    const w = await world();
    await endedSession(w, "ses_files", ["src/unpinned.ts"]);
    age(w);

    // Act & Assert — interim is the mode this hub ships in (§3.3g)
    await sweepSkeleton(deps(w), { mode: "interim" });
    expect(await rowsOf(w, "ses_files")).toBeGreaterThan(0);
    await sweepSkeleton(deps(w), FULL);
    expect(await rowsOf(w, "ses_files")).toBe(0);
  });
});

describe("what keeps a session", () => {
  test("a claim keeps its whole session, file touch and lifecycle included (CSK-1)", async () => {
    // Arrange
    const w = await world();
    await started(w, "ses_claim", ["src/x.ts"]);
    await post(w, "ses_claim", [claimIn("ses_claim", "clm_kept")]);
    await ended(w, "ses_claim");
    const before = await rowsOf(w, "ses_claim");
    age(w);

    // Act — FULL, so the file touch is not what keeps it
    await sweepSkeleton(deps(w), FULL);

    // Assert
    expect(await rowsOf(w, "ses_claim")).toBe(before);
  });

  test("a pin keeps the whole session, the evidence of a broken order included (CSK-11)", async () => {
    // Arrange — the only root is a pinned file the session touched, and the
    // session carries an epoch conflict on a row that is NOT the touch
    const w = await world();
    await started(w, "ses_pinned", ["src/pinned.ts"]);
    await w.harness.db.execute(sql`
      INSERT INTO session_events (id, session_id, kind, seq_kind, seq_reason, ref_kind, ref_id, observed_at)
      VALUES ('se_conflict', 'ses_pinned', 'claim.created', 'emitted', 'epoch_conflict', 'claim', 'clm_gone', ${w.harness.clock.now()})`);
    await ended(w, "ses_pinned");
    await pin(w, "pin_kept", ["src/pinned.ts"]);
    const before = await rowsOf(w, "ses_pinned");
    age(w);

    // Act
    await sweepSkeleton(deps(w), FULL);

    // Assert — every row, the conflict with them: without it the order would
    // read `usable` for a session whose order was `broken`
    expect(await rowsOf(w, "ses_pinned")).toBe(before);
    expect(
      await rows(w, sql`SELECT seq_reason FROM session_events WHERE id = 'se_conflict'`),
    ).toEqual([{ seq_reason: "epoch_conflict" }]);
  });

  test("a rename never shortens retention: both names keep their sessions (CSK-20)", async () => {
    // Arrange — A touches the old name, the sweep records the rename, B
    // touches the new name
    const w = await world();
    await endedSession(w, "ses_before", ["src/old.ts"]);
    await pin(w, "pin_renamed", ["src/old.ts"]);
    const swept = await w.harness.app.request(
      "/api/pins/sweep",
      jsonRequest("POST", w.nick.apiKey, {
        repo: REPO,
        updates: [{ pinId: "pin_renamed", path: "src/old.ts", newPath: "src/new.ts" }],
      }),
    );
    expect(swept.status).toBe(200);
    await endedSession(w, "ses_after", ["src/new.ts"]);
    age(w);

    // Act
    await sweepSkeleton(deps(w), FULL);

    // Assert
    expect(await rowsOf(w, "ses_before")).toBeGreaterThan(0);
    expect(await rowsOf(w, "ses_after")).toBeGreaterThan(0);
  });
});

describe("what the sweep cannot resolve, it keeps (§3.3e)", () => {
  /** One file-bearing session in the pin's repo and one in another, both aged; FULL mode. */
  const sweptAfter = async (
    unresolve: (w: World) => Promise<void>,
  ): Promise<{ readonly here: number; readonly elsewhere: number }> => {
    const w = await world();
    await endedSession(w, "ses_here", ["src/x.ts"]);
    await endedSession(w, "ses_elsewhere", ["src/x.ts"], OTHER_REPO);
    await unresolve(w);
    age(w);
    await sweepSkeleton(deps(w), FULL);
    return { here: await rowsOf(w, "ses_here"), elsewhere: await rowsOf(w, "ses_elsewhere") };
  };

  test("a touch with no file identity keeps its session (CSK-15 b)", async () => {
    // Act
    const left = await sweptAfter(async (w) => {
      await w.harness.db.execute(
        sql`UPDATE session_events SET file_ref = NULL WHERE session_id = 'ses_here' AND kind = 'file.modified'`,
      );
    });

    // Assert
    expect(left.here).toBeGreaterThan(0);
    expect(left.elsewhere).toBe(0);
  });

  test("a pin whose history holds a NULL keeps every file-bearing session of ITS repo (CSK-15 c)", async () => {
    // Act
    const left = await sweptAfter(async (w) => {
      await pin(w, "pin_legacy", ["src/other.ts"]);
      await w.harness.db.execute(sql`
        INSERT INTO pin_file_refs (pin_id, file_ref, unresolved_reason, first_seen)
        VALUES ('pin_legacy', NULL, 'rename_history_unrecorded', ${w.harness.clock.now()})`);
    });

    // Assert — the freeze is the repo's, not the hub's
    expect(left.here).toBeGreaterThan(0);
    expect(left.elsewhere).toBe(0);
  });

  test("a pin whose file git can no longer find freezes its repo (CSK-28)", async () => {
    // Act
    const left = await sweptAfter(async (w) => {
      await pin(w, "pin_missing", ["src/other.ts"]);
      await w.harness.db.execute(sql`UPDATE pin_files SET status = 'missing' WHERE pin_id = 'pin_missing'`);
    });

    // Assert
    expect(left.here).toBeGreaterThan(0);
    expect(left.elsewhere).toBe(0);
  });

  test("a pin with no history yet freezes its repo until the seed reaches it", async () => {
    // Act — the start-up seed has not run for this pin
    const left = await sweptAfter(async (w) => {
      await pin(w, "pin_unseeded", ["src/other.ts"]);
      await w.harness.db.execute(sql`DELETE FROM pin_file_refs WHERE pin_id = 'pin_unseeded'`);
    });

    // Assert
    expect(left.here).toBeGreaterThan(0);
    expect(left.elsewhere).toBe(0);
  });
});

/**
 * CSK-22: for each built root, a session reachable ONLY through it survives.
 * A Record over every root name, so a root added to the registry without a
 * case here is a compile error rather than an untested clause.
 */
const REACHED_ONLY_THROUGH: Readonly<
  Record<RetentionRootName, (w: World, sessionId: string) => Promise<void>>
> = {
  claims: async (w, sessionId) => {
    await post(w, sessionId, [claimIn(sessionId, `clm_${sessionId}`)]);
  },
  claim_edges: async (w, sessionId) => {
    // The edge's claims belong to another, live session; only the edge is this one's.
    await started(w, "ses_claims_owner");
    await post(w, "ses_claims_owner", [
      claimIn("ses_claims_owner", "clm_a"),
      claimIn("ses_claims_owner", "clm_b"),
    ]);
    await w.harness.db.execute(sql`
      INSERT INTO claim_edges (id, from_claim_id, to_claim_id, kind, author_session_id, created_at)
      VALUES ('edge_only', 'clm_a', 'clm_b', 'supports', ${sessionId}, ${w.harness.clock.now()})`);
  },
  pins: async (w, sessionId) => {
    await post(w, sessionId, [
      recordEnvelope("target", { workContextId: `wc_${sessionId}`, kind: "file", value: "src/pinned.ts" }, { sessionId }),
    ]);
    await pin(w, "pin_root", ["src/pinned.ts"]);
  },
  intent_versions: async (w, sessionId) => {
    await w.harness.db.execute(sql`
      INSERT INTO work_context_intents
        (id, work_context_id, version, author_session_id, seq_kind, seq_reason, provenance, summary, captured_at, wire)
      VALUES ('iv_only', ${`wc_${sessionId}`}, 1, ${sessionId}, 'observed', 'pre_seq_connector',
              'declared', 'Make playback resume', ${w.harness.clock.now()}, '{}'::jsonb)`);
  },
  pilot_sessions: async (w, sessionId) => {
    await w.harness.db.execute(sql`
      INSERT INTO pilot_sessions (session_id, repo, observed_at, end_reason, coverage)
      VALUES (${sessionId}, ${REPO}, ${w.harness.clock.now()}, 'ended', '[]'::jsonb)`);
  },
  pilot_attributions: async (w, sessionId) => {
    await pin(w, "pin_attributed", ["src/attributed.ts"]);
    await w.harness.db.execute(sql`
      INSERT INTO pilot_attributions
        (id, repo, pin_id, outcome, falsifier, top_session_id, top_lift, candidates, coverage_judgeable, answered_at)
      VALUES ('pa_only', ${REPO}, 'pin_attributed', 'ranked', 'recorded_break', ${sessionId}, 2, 1, true, ${w.harness.clock.now()})`);
  },
};

describe("every declared root is in the sweep, and does what it says (CSK-22)", () => {
  for (const root of retentionRoots()) {
    test(`a session reached only through ${root.name} survives`, async () => {
      // Arrange
      const w = await world();
      await started(w, "ses_only");
      await REACHED_ONLY_THROUGH[root.name](w, "ses_only");
      await ended(w, "ses_only");
      const before = await rowsOf(w, "ses_only");
      age(w);

      // Act — FULL, so a file touch is never what keeps it
      await sweepSkeleton(deps(w), FULL);

      // Assert
      expect(await rowsOf(w, "ses_only")).toBe(before);
    });
  }
});

describe("what never licenses a deletion", () => {
  test("a reaped session is not swept; revived and ended explicitly, it can be (CSK-23)", async () => {
    // Arrange — reaped: an end the hub INFERRED from silence
    const w = await world();
    await started(w, "ses_reaped");
    w.harness.clock.advanceSeconds((SESSION_REAP_STALE_HOURS + 1) * HOUR_SECONDS);
    const reaped = await reapStaleSessions(deps(w), { developerId: w.nick.developerId });
    expect(reaped.ended.map((row) => row.id)).toContain("ses_reaped");
    age(w);

    // Act
    await sweepSkeleton(deps(w));

    // Assert — kept while the end is only inferred
    expect(await rowsOf(w, "ses_reaped")).toBeGreaterThan(0);

    // Arrange — a record from the session disproves the reap; then it ends
    await post(w, "ses_reaped", [
      recordEnvelope(
        "work_context",
        validWorkContextBody({ id: "wc_revived", sessionId: "ses_reaped", description: undefined, createdAt: TEST_START_ISO }),
        { sessionId: "ses_reaped" },
      ),
    ]);
    await ended(w, "ses_reaped");
    age(w);

    // Act
    await sweepSkeleton(deps(w));

    // Assert
    expect(await rowsOf(w, "ses_reaped")).toBe(0);
  });

  test("a failed root check deletes nothing, is counted, and the reap still runs (CSK-17)", async () => {
    // Arrange — one root's clause errors; a stale live session waits to be reaped
    const w = await world();
    await endedSession(w, "ses_unjudged");
    age(w);
    await started(w, "ses_stale");
    w.harness.clock.advanceSeconds((SESSION_REAP_STALE_HOURS + 1) * HOUR_SECONDS);
    const broken: readonly RetentionRelation[] = RETENTION_REGISTRY.map((relation) =>
      relation.semantics === "root" && relation.name === "claims"
        ? { ...relation, reaches: () => sql`SELECT 1 FROM no_such_table` }
        : relation,
    );
    const failuresBefore = sweepLedger(w.harness.db).failures;

    // Act
    const pass = await reapStaleSessions(deps(w), { retentionRegistry: broken });

    // Assert
    expect(await rowsOf(w, "ses_unjudged")).toBeGreaterThan(0);
    expect(sweepLedger(w.harness.db).failures).toBe(failuresBefore + 1);
    expect(pass.ended.map((row) => row.id)).toContain("ses_stale");
  });

  test("a later pass that succeeds clears the failure count, and off records no pass", async () => {
    // Arrange — one failed pass
    const w = await world();
    const broken: readonly RetentionRelation[] = RETENTION_REGISTRY.map((relation) =>
      relation.semantics === "root" && relation.name === "claims"
        ? { ...relation, reaches: () => sql`SELECT 1 FROM no_such_table` }
        : relation,
    );
    await sweepSkeleton(deps(w), { registry: broken });
    expect(sweepLedger(w.harness.db).failures).toBe(1);

    // Act — the fault is gone
    await sweepSkeleton(deps(w));

    // Assert — a WARN that outlives its fault is one people learn to ignore
    expect(sweepLedger(w.harness.db).failures).toBe(0);

    // And a hub whose mode is off runs no pass, so reports none
    const off = await world();
    await sweepSkeleton(deps(off), { mode: "off" });
    expect(await readSkeletonRetentionReport(deps(off))).toMatchObject({ lastPassAt: null, completedAt: null });
  });

  test("a failure is counted on the hub it happened on, and no other", async () => {
    // Arrange — two hubs in one process, as in every test run
    const failing = await world();
    const other = await world();
    const broken: readonly RetentionRelation[] = RETENTION_REGISTRY.map((relation) =>
      relation.semantics === "root" && relation.name === "claims"
        ? { ...relation, reaches: () => sql`SELECT 1 FROM no_such_table` }
        : relation,
    );

    // Act
    await sweepSkeleton(deps(failing), { registry: broken });
    await sweepSkeleton(deps(other));

    // Assert — the other hub's doctor must not WARN about a pass it never ran
    expect(sweepLedger(failing.harness.db).failures).toBe(1);
    expect(sweepLedger(other.harness.db).failures).toBe(0);
  });

  test("a declared root nobody built stops the sweep, and names itself (CSK-26)", async () => {
    // Arrange
    const w = await world();
    await endedSession(w, "ses_waiting");
    age(w);
    const unbuilt: readonly RetentionRelation[] = RETENTION_REGISTRY.map((relation) =>
      relation.semantics === "root" && relation.name === "pilot_sessions"
        ? { ...relation, status: "not_built" as const }
        : relation,
    );

    // Act
    const outcome = await sweepSkeleton(deps(w), { registry: unbuilt });

    // Assert
    expect(outcome).toEqual({ kind: "held", heldBy: ["pilot_sessions"] });
    expect(await rowsOf(w, "ses_waiting")).toBeGreaterThan(0);
  });

  test("the check and the delete are one statement, in one transaction (CSK-18)", async () => {
    // Arrange — record what the sweep sends: a check awaited apart from its
    // delete would let a root committed between the two be deleted under
    const w = await world();
    await endedSession(w, "ses_counted");
    age(w);
    const sent: string[] = [];
    const db = w.harness.db;
    const counting = new Proxy(db, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (property === "execute") {
          sent.push("execute");
        }
        if (property === "transaction") {
          sent.push("transaction");
          return (work: Parameters<typeof db.transaction>[0]) =>
            target.transaction((tx) =>
              work(
                new Proxy(tx, {
                  get(inner, name, innerReceiver) {
                    const member: unknown = Reflect.get(inner, name, innerReceiver);
                    if (name === "execute") {
                      sent.push("tx.execute");
                    }
                    return typeof member === "function" ? member.bind(inner) : member;
                  },
                }),
              ),
            );
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    // Act
    await sweepSkeleton({ db: counting, now: w.harness.clock.now });

    // Assert
    expect(sent).toEqual(["transaction", "tx.execute"]);
    expect(await rowsOf(w, "ses_counted")).toBe(0);
  });
});

describe("what doctor is told the sweep keeps (01a §5, CSK-19 b)", () => {
  test("each reason is counted by the clause the sweep itself uses", async () => {
    // Arrange — past the window: one kept by a claim (a root whose liveness
    // 02/04 still owe), one kept by an unresolved touch, one reaped; and one
    // pin the hub cannot tie to its files
    const w = await world();
    await started(w, "ses_claimed");
    await post(w, "ses_claimed", [claimIn("ses_claimed", "clm_report")]);
    await ended(w, "ses_claimed");
    await endedSession(w, "ses_unresolved", ["src/x.ts"]);
    await w.harness.db.execute(
      sql`UPDATE session_events SET file_ref = NULL WHERE session_id = 'ses_unresolved' AND kind = 'file.modified'`,
    );
    await started(w, "ses_silent");
    w.harness.clock.advanceSeconds((SESSION_REAP_STALE_HOURS + 1) * HOUR_SECONDS);
    await reapStaleSessions(deps(w), { developerId: w.nick.developerId });
    await pin(w, "pin_lost", ["src/lost.ts"]);
    await w.harness.db.execute(sql`UPDATE pin_files SET status = 'missing' WHERE pin_id = 'pin_lost'`);
    age(w);

    // Act — one pass completes the cycle on a hub this small
    const before = await readSkeletonRetentionReport(deps(w));
    await sweepSkeleton(deps(w), FULL);
    const report = await readSkeletonRetentionReport(deps(w));

    // Assert — nothing is claimed before a cycle has been judged…
    expect(before).toMatchObject({ completedAt: null, lastPassAt: null, aged: 0 });
    // …and afterwards the report is that judgement, whole
    expect(report).toMatchObject({
      heldBy: [],
      completedAt: w.harness.clock.now().toISOString(),
      aged: 2,
      swept: 0,
      unresolved: 1,
      fileBearing: 1,
      reapedAwaitingEnd: 1,
      unresolvedPins: 1,
      unresolvedPinIds: ["pin_lost"],
    });
    // The whole table, so a report that counted the complement cannot
    // coincide with it on one root
    expect(report.keptBy).toEqual([
      { root: "claims", sessions: 1 },
      { root: "claim_edges", sessions: 0 },
      { root: "pins", sessions: 0 },
      { root: "intent_versions", sessions: 0 },
      { root: "pilot_sessions", sessions: 0 },
      { root: "pilot_attributions", sessions: 0 },
    ]);
    expect(await rowsOf(w, "ses_claimed")).toBeGreaterThan(0);
    expect(await rowsOf(w, "ses_unresolved")).toBeGreaterThan(0);
    expect(await rowsOf(w, "ses_silent")).toBeGreaterThan(0);
  });
});

describe("a pass costs a window, never the hub (01a §6)", () => {
  test("kept sessions do not stall the eligible ones behind them, and the cycle reports all", async () => {
    // Arrange — the three OLDEST are kept by a claim; two newer ones are not.
    // A pass bounded only by what it deletes would judge the kept ones first,
    // every pass, for ever.
    const w = await world();
    for (const id of ["ses_k1", "ses_k2", "ses_k3"]) {
      await started(w, id);
      await post(w, id, [claimIn(id, `clm_${id}`)]);
      await ended(w, id);
      w.harness.clock.advanceSeconds(HOUR_SECONDS);
    }
    await endedSession(w, "ses_e1");
    w.harness.clock.advanceSeconds(HOUR_SECONDS);
    await endedSession(w, "ses_e2");
    age(w);

    // Act — windows of two: k1 k2 | k3 e1 | e2
    const passes = [];
    for (let pass = 0; pass < 3; pass += 1) {
      passes.push(await sweepSkeleton(deps(w), { window: 2 }));
    }

    // Assert — both eligible sessions went, the kept stayed, and only the
    // third pass completed the cycle, reporting all five
    expect(passes).toEqual([
      { kind: "swept", sessions: 0, rows: 0 },
      { kind: "swept", sessions: 1, rows: 2 },
      { kind: "swept", sessions: 1, rows: 2 },
    ]);
    expect(await rowsOf(w, "ses_e1")).toBe(0);
    expect(await rowsOf(w, "ses_e2")).toBe(0);
    expect(await rowsOf(w, "ses_k1")).toBeGreaterThan(0);
    expect(await readSkeletonRetentionReport(deps(w))).toMatchObject({ aged: 5, swept: 2 });
  });
});

describe("a retired session stays retired (01a §3.3g)", () => {
  test("a record that arrives after the sweep writes no skeleton row", async () => {
    // Arrange — swept whole
    const w = await world();
    await endedSession(w, "ses_retired");
    age(w);
    await sweepSkeleton(deps(w));
    expect(await rowsOf(w, "ses_retired")).toBe(0);

    // Act — a live successor flushes a claim the retired session authored
    // (author sessions may already be ended; only the producer must be live)
    await started(w, "ses_successor");
    await post(w, "ses_successor", [
      recordEnvelope(
        "claim",
        validClaimBody({
          id: "clm_late",
          workContextId: "wc_ses_retired",
          authorSessionId: "ses_retired",
          body: "Playback resumes after a seek (late)",
        }),
        { sessionId: "ses_successor" },
      ),
    ]);

    // Assert — the claim is stored, and no part of a skeleton is rebuilt: one
    // row alone would read as a usable order the whole may have contradicted
    expect(await rows(w, sql`SELECT id FROM claims WHERE id = 'clm_late'`)).toHaveLength(1);
    expect(await rowsOf(w, "ses_retired")).toBe(0);
  });
});

describe("a reaped session's own end is kept (01a §3.3a)", () => {
  const EPOCH = "0f1e2d3c-4b5a-4968-8776-655443322110";

  const reaped = async (w: World, sessionId: string): Promise<void> => {
    await started(w, sessionId);
    w.harness.clock.advanceSeconds((SESSION_REAP_STALE_HOURS + 1) * HOUR_SECONDS);
    await reapStaleSessions(deps(w), { developerId: w.nick.developerId });
  };

  const ends = (w: World, sessionId: string) =>
    rows(
      w,
      sql`SELECT seq_reason, seq_n FROM session_events
           WHERE session_id = ${sessionId} AND kind = 'session.ended'`,
    );

  const ledger = (w: World, sessionId: string) =>
    rows(
      w,
      sql`SELECT kind FROM events WHERE payload->>'sessionId' = ${sessionId}
           AND kind IN ('session_started', 'session_ended') ORDER BY id`,
    );

  test("a positioned SessionEnd after a reap is the session's one end, and the ledger balances", async () => {
    // Arrange
    const w = await world();
    await reaped(w, "ses_idle");

    // Act — the connector's own SessionEnd, with the position it allocated
    await endSession(deps(w), w.nick.developerId, "ses_idle", undefined, { epoch: EPOCH, n: 7 });

    // Assert — the reported end replaced the inferred one…
    expect(
      await rows(w, sql`SELECT reaped_at FROM agent_sessions WHERE id = 'ses_idle'`),
    ).toEqual([{ reaped_at: null }]);
    expect(await ends(w, "ses_idle")).toEqual([{ seq_reason: "sequenced", seq_n: 7 }]);
    // …and the ledger reads start, (reaped) end, start (the reap disproven), end
    expect((await ledger(w, "ses_idle")).map((row) => row["kind"])).toEqual([
      "session_started",
      "session_ended",
      "session_started",
      "session_ended",
    ]);

    // And it is now an explicit end the sweep may act on
    age(w);
    await sweepSkeleton(deps(w));
    expect(await rowsOf(w, "ses_idle")).toBe(0);
  });

  test("an unpositioned SessionEnd after a reap is not swallowed by the reaper's row", async () => {
    // Arrange
    const w = await world();
    await reaped(w, "ses_old_connector");

    // Act — a connector from before positions: no seq at all
    await ended(w, "ses_old_connector");

    // Assert — the session's end says what it is, not "inferred from silence"
    expect(await ends(w, "ses_old_connector")).toEqual([
      { seq_reason: "pre_seq_connector", seq_n: null },
    ]);
  });
});

