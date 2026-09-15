/**
 * The coverage record's SHAPE (docs/1.0/03-coverage-integrity.md §3.1, §3.2).
 *
 * COV-2 and the data half of COV-5 live here. Both are about the same defect
 * in two directions: a rung that cannot be read must still be a ROW, and a
 * rung that cannot EXIST must not be readable as one that might.
 */
import { describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import {
  ABSENCE_MAX_EVIDENCE_ROWS,
  ABSENCE_MAX_FINDINGS,
} from "../src/constants.ts";
import {
  agentSessions,
  commitEvidence,
  developerEmails,
  workContextTargets,
  workContexts,
} from "../src/db/schema.ts";
import { listAbsences, readAbsenceCensus } from "../src/services/absences.ts";
import {
  COVERAGE_SOURCES,
  isJudgeable,
  readCoverage,
} from "../src/services/coverage.ts";
import {
  TEST_START_ISO,
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
} from "./helpers.ts";
import type { TestHarness } from "./helpers.ts";

const REPO = "github.com/acme/api";
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const at = (offsetMs: number): Date =>
  new Date(new Date(TEST_START_ISO).getTime() + offsetMs);

/** The API key each seeded viewer was issued, for the route-level test. */
const apiKeys = new Map<string, string>();

const seed = async (): Promise<{
  harness: TestHarness;
  viewerId: string;
}> => {
  const harness = await createTestHarness();
  const developer = await createTestDeveloper(harness, "Nick", "nick@example.com");
  apiKeys.set(developer.developerId, developer.apiKey);
  return { harness, viewerId: developer.developerId };
};

interface SessionRow {
  readonly id: string;
  readonly lastHeartbeatAt: Date;
  readonly endedAt?: Date | null;
  readonly reapedAt?: Date | null;
  readonly repo?: string;
}

const insertSession = async (
  harness: TestHarness,
  developerId: string,
  row: SessionRow,
): Promise<void> => {
  await harness.db.insert(agentSessions).values({
    id: row.id,
    developerId,
    agentKind: "claude-code",
    repo: row.repo ?? REPO,
    branch: "main",
    baseCommit: "a1b2c3d4",
    status: "analyzing",
    startedAt: at(-60 * MINUTE_MS),
    lastHeartbeatAt: row.lastHeartbeatAt,
    endedAt: row.endedAt ?? null,
    reapedAt: row.reapedAt ?? null,
  });
};

const agentEventOf = async (
  harness: TestHarness,
  viewerId: string,
): Promise<{
  state: string;
  reason: string;
  gapSince: string | null;
  observedAt: string | null;
}> => {
  const record = await readCoverage(
    { db: harness.db, now: harness.clock.now },
    viewerId,
    REPO,
  );
  const row = record.sources.find((entry) => entry.source === "agent_event");
  if (row === undefined) {
    throw new Error("agent_event row missing");
  }
  return row;
};

describe("COV-2: five rows, in order, no scalar", () => {
  test("readCoverage emits exactly one record per source in COVERAGE_SOURCES order", async () => {
    // Arrange
    const { harness, viewerId } = await seed();

    // Act
    const record = await readCoverage(
      { db: harness.db, now: harness.clock.now },
      viewerId,
      REPO,
    );

    // Assert
    expect(record.sources.map((source) => source.source)).toEqual([
      ...COVERAGE_SOURCES,
    ]);
  });

  test("the record carries no aggregate — no overall, no count, no percentage", async () => {
    // Arrange
    const { harness, viewerId } = await seed();

    // Act
    const record = await readCoverage(
      { db: harness.db, now: harness.clock.now },
      viewerId,
      REPO,
    );

    // Assert: every own value is a string, or the five-row array itself.
    const scalars = Object.entries(record).filter(
      ([key]) => key !== "sources" && key !== "scope",
    );
    expect(scalars.every(([, value]) => typeof value === "string")).toBe(true);
    expect(Object.keys(record).sort()).toEqual([
      "computedAt",
      "repo",
      "scope",
      "sources",
    ]);
  });
});

describe("COV-5: three rungs refuse, by name", () => {
  test.each([
    ["ci", "no_emitter"],
    ["runtime", "out_of_scope_1_0"],
    ["human_edit", "no_platform_rung"],
  ] as const)(
    "%s is unavailable with reason %s — never unknown, never complete",
    async (source, reason) => {
      // Arrange
      const { harness, viewerId } = await seed();

      // Act
      const record = await readCoverage(
        { db: harness.db, now: harness.clock.now },
        viewerId,
        REPO,
      );
      const row = record.sources.find((entry) => entry.source === source);

      // Assert
      expect(row?.state).toBe("unavailable");
      expect(row?.reason).toBe(reason);
      expect(row?.gapSince).toBeNull();
    },
  );
});

/**
 * COV-4 — the defect this rung exists for. `reaped_at` is set beside
 * `ended_at` when the HUB guessed the session was over (db/schema.ts:145-152);
 * a SessionEnd the connector reported is a FACT and a reap is an INFERENCE
 * from silence. Read as the same thing, a killed terminal — 104 of 127 in the
 * measured trial — becomes "we watched that session to its end".
 */
describe("COV-4: a reaped end is not a clean end", () => {
  test("two sessions identical but for reaped_at read complete and incomplete", async () => {
    // Arrange: one session the connector ended, one the hub reaped
    const reported = await seed();
    await insertSession(reported.harness, reported.viewerId, {
      id: "ses_reported",
      lastHeartbeatAt: at(-30 * MINUTE_MS),
      endedAt: at(-29 * MINUTE_MS),
    });
    const reaped = await seed();
    await insertSession(reaped.harness, reaped.viewerId, {
      id: "ses_reaped",
      lastHeartbeatAt: at(-30 * MINUTE_MS),
      endedAt: at(-29 * MINUTE_MS),
      reapedAt: at(-29 * MINUTE_MS),
    });

    // Act
    const reportedRow = await agentEventOf(reported.harness, reported.viewerId);
    const reapedRow = await agentEventOf(reaped.harness, reaped.viewerId);

    // Assert
    expect(reportedRow.state).toBe("complete");
    expect(reportedRow.reason).toBe("sessions_reported");
    expect(reportedRow.gapSince).toBeNull();
    expect(reapedRow.state).toBe("incomplete");
    expect(reapedRow.reason).toBe("session_reaped");
    expect(reapedRow.gapSince).toBe(at(-30 * MINUTE_MS).toISOString());
  });

  test("an unclosed session past the presence cutoff is incomplete, not live", async () => {
    // Arrange: no ended_at, and the last heartbeat is older than the TTL
    const { harness, viewerId } = await seed();
    await insertSession(harness, viewerId, {
      id: "ses_silent",
      lastHeartbeatAt: at(-45 * MINUTE_MS),
    });

    // Act
    const row = await agentEventOf(harness, viewerId);

    // Assert
    expect(row.state).toBe("incomplete");
    expect(row.reason).toBe("session_silent");
    expect(row.gapSince).toBe(at(-45 * MINUTE_MS).toISOString());
  });

  test("an unclosed session still heartbeating is complete — live is not a gap", async () => {
    // Arrange
    const { harness, viewerId } = await seed();
    await insertSession(harness, viewerId, {
      id: "ses_live",
      lastHeartbeatAt: at(-30_000),
    });

    // Act
    const row = await agentEventOf(harness, viewerId);

    // Assert
    expect(row.state).toBe("complete");
    expect(row.observedAt).toBe(at(-30_000).toISOString());
  });

  test("no session on this repo is unknown — not complete, because no session is not proof nobody worked", async () => {
    // Arrange: a session on ANOTHER repo only
    const { harness, viewerId } = await seed();
    await insertSession(harness, viewerId, {
      id: "ses_elsewhere",
      repo: "github.com/acme/web",
      lastHeartbeatAt: at(-30 * MINUTE_MS),
      endedAt: at(-29 * MINUTE_MS),
    });

    // Act
    const row = await agentEventOf(harness, viewerId);

    // Assert
    expect(row.state).toBe("unknown");
    expect(row.reason).toBe("no_session_in_window");
    expect(row.gapSince).toBeNull();
    expect(row.observedAt).toBeNull();
  });

  test("a session older than the coverage window is out of scope, not a gap", async () => {
    // Arrange: reaped, but twenty days ago
    const { harness, viewerId } = await seed();
    await insertSession(harness, viewerId, {
      id: "ses_ancient",
      lastHeartbeatAt: at(-20 * 24 * 60 * MINUTE_MS),
      endedAt: at(-20 * 24 * 60 * MINUTE_MS),
      reapedAt: at(-20 * 24 * 60 * MINUTE_MS),
    });

    // Act
    const row = await agentEventOf(harness, viewerId);

    // Assert
    expect(row.state).toBe("unknown");
    expect(row.reason).toBe("no_session_in_window");
  });
});

interface EvidenceRow {
  readonly authorEmail: string;
  readonly authorName: string;
  readonly latestCommitAt: Date;
  readonly collectedAt: Date;
}

const insertEvidence = async (
  harness: TestHarness,
  reportedBy: string,
  row: EvidenceRow,
): Promise<void> => {
  await harness.db.insert(commitEvidence).values({
    repo: REPO,
    authorEmail: row.authorEmail,
    authorName: row.authorName,
    latestCommitAt: row.latestCommitAt,
    commitCount: 3,
    windowDays: 14,
    collectedAt: row.collectedAt,
    reportedBy,
  });
};

/**
 * `count` evidence rows that produce NO finding, all newer than anything the
 * caller adds afterwards — the population that fills `listAbsences`' bound
 * without being an absence itself. One developer with `count` alias addresses
 * rather than `count` developers: `developer_emails` is keyed on email, so
 * every row matches the same member, and that member's session postdates
 * every commit here.
 */
const fillEvidenceToTheBound = async (
  harness: TestHarness,
  viewerId: string,
  count: number,
): Promise<void> => {
  await insertSession(harness, viewerId, {
    id: "ses_filler",
    lastHeartbeatAt: at(-30 * MINUTE_MS),
    endedAt: at(-29 * MINUTE_MS),
  });
  const emails = Array.from(
    { length: count },
    (_unused, index) => `alias${String(index).padStart(4, "0")}@acme.example`,
  );
  await harness.db.insert(developerEmails).values(
    emails.map((email) => ({
      email,
      developerId: viewerId,
      isPrimary: false,
      createdAt: at(-2 * DAY_MS),
    })),
  );
  await harness.db.insert(commitEvidence).values(
    emails.map((email, index) => ({
      repo: REPO,
      authorEmail: email,
      authorName: `Alias ${String(index)}`,
      latestCommitAt: at(-(60 + index) * MINUTE_MS),
      commitCount: 3,
      windowDays: 14,
      collectedAt: at(-MINUTE_MS),
      reportedBy: viewerId,
    })),
  );
};

const gitOf = async (
  harness: TestHarness,
  viewerId: string,
): Promise<{
  state: string;
  reason: string;
  gapSince: string | null;
  observedAt: string | null;
}> => {
  const record = await readCoverage(
    { db: harness.db, now: harness.clock.now },
    viewerId,
    REPO,
  );
  const row = record.sources.find((entry) => entry.source === "git");
  if (row === undefined) {
    throw new Error("git row missing");
  }
  return row;
};

/**
 * The seam defect this rung exists for. `listAbsences` filters evidence older
 * than ABSENCE_EVIDENCE_MAX_AGE_DAYS out of its own query (absences.ts:148),
 * so a repo whose newest collection is nine days old returns ZERO findings —
 * byte-identical to a repo nobody has ever collected evidence for. Those are
 * different answers: one says "the archive stopped being refreshed", the
 * other says "there is no archive". The git rung needs its OWN unwindowed
 * aggregate to tell them apart, which is what these two tests pin.
 */
describe("git: stale evidence is not the same answer as no evidence", () => {
  test("evidence collected nine days ago is incomplete / evidence_stale", async () => {
    // Arrange
    const { harness, viewerId } = await seed();
    await insertEvidence(harness, viewerId, {
      authorEmail: "sam@external.example",
      authorName: "Sam Stranger",
      latestCommitAt: at(-9 * DAY_MS),
      collectedAt: at(-9 * DAY_MS),
    });

    // Act
    const row = await gitOf(harness, viewerId);

    // Assert
    expect(row.state).toBe("incomplete");
    expect(row.reason).toBe("evidence_stale");
    expect(row.observedAt).toBe(at(-9 * DAY_MS).toISOString());
    expect(row.gapSince).toBe(at(-9 * DAY_MS).toISOString());
  });

  test("no commit_evidence row at all is unknown / no_commit_evidence", async () => {
    // Arrange: nothing ingested
    const { harness, viewerId } = await seed();

    // Act
    const row = await gitOf(harness, viewerId);

    // Assert
    expect(row.state).toBe("unknown");
    expect(row.reason).toBe("no_commit_evidence");
    expect(row.gapSince).toBeNull();
    expect(row.observedAt).toBeNull();
  });

  test("fresh evidence naming a commit author with no reported session is incomplete", async () => {
    // Arrange: an author no hub member's email matches
    const { harness, viewerId } = await seed();
    await insertEvidence(harness, viewerId, {
      authorEmail: "sam@external.example",
      authorName: "Sam Stranger",
      latestCommitAt: at(-2 * DAY_MS),
      collectedAt: at(-1 * 60 * MINUTE_MS),
    });

    // Act
    const row = await gitOf(harness, viewerId);

    // Assert
    expect(row.state).toBe("incomplete");
    expect(row.reason).toBe("commit_authors_unreported");
    expect(row.gapSince).toBe(at(-2 * DAY_MS).toISOString());
    expect(row.observedAt).toBe(at(-1 * 60 * MINUTE_MS).toISOString());
  });

  test("fresh evidence whose authors all reported a session is complete", async () => {
    // Arrange: the viewer's own commits, an hour after their own session
    const { harness, viewerId } = await seed();
    await insertSession(harness, viewerId, {
      id: "ses_reported",
      lastHeartbeatAt: at(-3 * 60 * MINUTE_MS),
      endedAt: at(-3 * 60 * MINUTE_MS),
    });
    await insertEvidence(harness, viewerId, {
      authorEmail: "nick@example.com",
      authorName: "nick-git",
      latestCommitAt: at(-2 * 60 * MINUTE_MS),
      collectedAt: at(-1 * 60 * MINUTE_MS),
    });

    // Act
    const row = await gitOf(harness, viewerId);

    // Assert
    expect(row.state).toBe("complete");
    expect(row.reason).toBe("commits_reported");
    expect(row.gapSince).toBeNull();
    expect(row.observedAt).toBe(at(-1 * 60 * MINUTE_MS).toISOString());
  });

  /**
   * PR #50's word collision, guarded rather than commented.
   * `GitTouchesOutcome.unavailable` (connector-core/src/flows/capture-git-touches.ts:83-88)
   * means "git DID NOT ANSWER — a deadline, no repository, no binary". That is
   * coverage `unknown`: the rung EXISTS and nobody answered. Coverage
   * `unavailable` means the rung CANNOT EXIST, which is never true of git.
   */
  test.each([
    ["no evidence", false],
    ["stale evidence", true],
  ] as const)(
    "the git rung never reads unavailable — %s",
    async (_label, withEvidence) => {
      // Arrange
      const { harness, viewerId } = await seed();
      if (withEvidence) {
        await insertEvidence(harness, viewerId, {
          authorEmail: "sam@external.example",
          authorName: "Sam Stranger",
          latestCommitAt: at(-9 * DAY_MS),
          collectedAt: at(-9 * DAY_MS),
        });
      }

      // Act
      const row = await gitOf(harness, viewerId);

      // Assert
      expect(row.state).not.toBe("unavailable");
    },
  );
});

/**
 * THE CUT IS NOT A CENSUS (`listAbsences` caps twice, and coverage read the
 * cap as an answer).
 *
 * `listAbsences` returns at most ABSENCE_MAX_EVIDENCE_ROWS evidence rows
 * ordered `latest_commit_at DESC` (absences.ts:155-156) and then at most
 * ABSENCE_MAX_FINDINGS findings (:190). Both bounds drop the STALEST
 * committers first — which is exactly the population an absence check exists
 * to find. A git rung that read `findings.length === 0` as proof would turn
 * "we stopped looking at 200 rows" into `complete`, and `isJudgeable` with
 * it: AT-5's "fails if" reached by team size rather than by anything about
 * observation.
 *
 * The boundary is ONE ROW WIDE and it is crossed by how many addresses commit
 * to a repo, so these two tests are a pair: identical corpora but for the row
 * that falls off the end.
 */
describe("git: a bounded listing is not proof that nobody is absent", () => {
  test("an absentee cut by the evidence bound still reads incomplete", async () => {
    // Arrange: ABSENCE_MAX_EVIDENCE_ROWS reported authors with newer commits,
    // and one contractor nobody matches whose commit is the oldest — so the
    // DESC order puts the only finding one row past the bound.
    const { harness, viewerId } = await seed();
    await fillEvidenceToTheBound(harness, viewerId, ABSENCE_MAX_EVIDENCE_ROWS);
    await insertEvidence(harness, viewerId, {
      authorEmail: "contractor@external.example",
      authorName: "Cass Contractor",
      latestCommitAt: at(-6 * DAY_MS),
      collectedAt: at(-MINUTE_MS),
    });

    // Act
    const row = await gitOf(harness, viewerId);

    // Assert: one commit author on this repo has no reported session at all.
    expect(row.state).toBe("incomplete");
    expect(row.reason).toBe("commit_authors_unreported");
  });

  test("the same corpus one row under the bound reads incomplete too", async () => {
    // Arrange: the control — nothing is cut, so this is what the case above
    // has to agree with.
    const { harness, viewerId } = await seed();
    await fillEvidenceToTheBound(
      harness,
      viewerId,
      ABSENCE_MAX_EVIDENCE_ROWS - 1,
    );
    await insertEvidence(harness, viewerId, {
      authorEmail: "contractor@external.example",
      authorName: "Cass Contractor",
      latestCommitAt: at(-6 * DAY_MS),
      collectedAt: at(-MINUTE_MS),
    });

    // Act
    const row = await gitOf(harness, viewerId);

    // Assert
    expect(row.state).toBe("incomplete");
    expect(row.reason).toBe("commit_authors_unreported");
  });

  test("`isJudgeable` is false while an absentee sits past the bound", async () => {
    // Arrange
    const { harness, viewerId } = await seed();
    await insertSession(harness, viewerId, {
      id: "ses_clean",
      lastHeartbeatAt: at(-30 * MINUTE_MS),
      endedAt: at(-29 * MINUTE_MS),
    });
    await fillEvidenceToTheBound(harness, viewerId, ABSENCE_MAX_EVIDENCE_ROWS);
    await insertEvidence(harness, viewerId, {
      authorEmail: "contractor@external.example",
      authorName: "Cass Contractor",
      latestCommitAt: at(-6 * DAY_MS),
      collectedAt: at(-MINUTE_MS),
    });

    // Act
    const record = await readCoverage(
      { db: harness.db, now: harness.clock.now },
      viewerId,
      REPO,
    );

    // Assert: principle 1 — only judge when you know you were watching.
    expect(isJudgeable(record)).toBe(false);
  });

  test("under both caps the census and the listing are the same answer", async () => {
    // Arrange: the gap predicate is now spelled twice — once in JS over the
    // bounded listing, once in SQL over the unbounded census. Under both caps
    // the listing IS a census, so the two must agree row for row and instant
    // for instant, or one of them has drifted.
    const { harness, viewerId } = await seed();
    await insertSession(harness, viewerId, {
      id: "ses_mine",
      lastHeartbeatAt: at(-3 * DAY_MS),
      endedAt: at(-3 * DAY_MS),
    });
    await harness.db.insert(developerEmails).values({
      email: "nick-alias@acme.example",
      developerId: viewerId,
      isPrimary: false,
      createdAt: at(-2 * DAY_MS),
    });
    // (a) a member who committed long after their last reported session,
    // (b) a member whose commit is inside the grace window, (c) an address
    // no member matches at all.
    await insertEvidence(harness, viewerId, {
      authorEmail: "nick-alias@acme.example",
      authorName: "Nick Alias",
      latestCommitAt: at(-MINUTE_MS),
      collectedAt: at(-MINUTE_MS),
    });
    await insertEvidence(harness, viewerId, {
      authorEmail: "nick@example.com",
      authorName: "Nick Primary",
      latestCommitAt: at(-3 * DAY_MS + MINUTE_MS),
      collectedAt: at(-MINUTE_MS),
    });
    await insertEvidence(harness, viewerId, {
      authorEmail: "stranger@external.example",
      authorName: "Sam Stranger",
      latestCommitAt: at(-5 * DAY_MS),
      collectedAt: at(-MINUTE_MS),
    });
    const deps = { db: harness.db, now: harness.clock.now };

    // Act
    const findings = await listAbsences(deps, viewerId, REPO);
    const census = await readAbsenceCensus(deps, viewerId, REPO);

    // Assert
    expect(findings.length).toBeLessThan(ABSENCE_MAX_FINDINGS);
    expect(census.unreportedAuthors).toBe(findings.length);
    expect(census.unreportedAuthors).toBe(2);
    const sessions = findings
      .map((finding) => finding.lastSessionAt)
      .filter((value): value is string => value !== null)
      .sort();
    expect(census.earliestSessionAt).toBe(sessions[0] ?? null);
    const commits = [...findings.map((finding) => finding.latestCommitAt)].sort();
    expect(census.earliestCommitAt).toBe(commits[0] ?? null);
  });

  test("the gap instant is the EARLIEST, not the earliest of the kept 20", async () => {
    // Arrange: ABSENCE_MAX_FINDINGS + 5 unreported authors. The findings cap
    // keeps the 20 most RECENT, so a minimum taken over the kept list is
    // taken over the wrong end of the distribution — always later than the
    // truth, always in the reassuring direction.
    const { harness, viewerId } = await seed();
    const oldest = at(-13 * DAY_MS);
    for (let index = 0; index < ABSENCE_MAX_FINDINGS + 5; index += 1) {
      await insertEvidence(harness, viewerId, {
        authorEmail: `absent${String(index)}@external.example`,
        authorName: `Absent ${String(index)}`,
        latestCommitAt: new Date(oldest.getTime() + index * 60 * MINUTE_MS),
        collectedAt: at(-MINUTE_MS),
      });
    }

    // Act
    const row = await gitOf(harness, viewerId);

    // Assert: "observation has been unreliable since AT LEAST here" is a
    // lower bound or it is a lie.
    expect(row.state).toBe("incomplete");
    expect(row.gapSince).toBe(oldest.toISOString());
  });
});

/**
 * §3.5's wire, and Nick's decision 1: coverage rides INSIDE the response that
 * exists rather than on a ninth parallel GET. PGlite is a single-connection
 * embedded database (services/search.ts:59-67), so parallel GETs serialise on
 * the hub and a new one at SessionStart would spend the 1000 ms budget
 * looking free in wall clock.
 */
describe("GET /api/absences carries the coverage record", () => {
  test("the response body names five sources beside the findings", async () => {
    // Arrange
    const { harness, viewerId } = await seed();
    await insertSession(harness, viewerId, {
      id: "ses_reaped",
      lastHeartbeatAt: at(-30 * MINUTE_MS),
      endedAt: at(-29 * MINUTE_MS),
      reapedAt: at(-29 * MINUTE_MS),
    });
    const developer = await harness.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, "ses_reaped"));
    expect(developer.length).toBe(1);

    // Act
    const response = await harness.app.request(
      `/api/absences?repo=${encodeURIComponent(REPO)}`,
      jsonRequest("GET", apiKeys.get(viewerId) ?? null),
    );
    const body = (await response.json()) as {
      data: {
        absences: unknown[];
        coverage: {
          repo: string;
          sources: { source: string; state: string }[];
        };
      };
    };

    // Assert
    expect(response.status).toBe(200);
    expect(Array.isArray(body.data.absences)).toBe(true);
    expect(body.data.coverage.repo).toBe(REPO);
    expect(body.data.coverage.sources.map((row) => row.source)).toEqual([
      ...COVERAGE_SOURCES,
    ]);
    expect(
      body.data.coverage.sources.find((row) => row.source === "agent_event")
        ?.state,
    ).toBe("incomplete");
  });
});

const insertTouch = async (
  harness: TestHarness,
  sessionId: string,
  contextId: string,
  path: string,
): Promise<void> => {
  await harness.db.insert(workContexts).values({
    id: contextId,
    sessionId,
    title: "work",
    status: "analyzing",
    createdAt: at(-40 * MINUTE_MS),
  });
  await harness.db.insert(workContextTargets).values({
    workContextId: contextId,
    kind: "file",
    value: path,
    source: "tool_edit",
    createdAt: at(-40 * MINUTE_MS),
  });
};

/**
 * §3.2a. Unscoped, `agent_event: complete` needs every session on the whole
 * repo over the whole window to have reported cleanly — and the tree's own
 * measurement says that is the normal state, not the exception (104 of 127
 * trial sessions never closed). One abandoned session anywhere in fourteen
 * days would flip the entire repo to `incomplete` for ever, which makes
 * UNATTRIBUTED unreachable in practice and fires the annotation on nearly
 * every answer.
 *
 * The fix is GRANULARITY, not softening: a gap is still a gap, it is just
 * measured about the thing that was asked.
 */
describe("§3.2a: the scope measures the question, not the whole repo", () => {
  test("a pin's file set reads complete where the repo-wide call reads incomplete", async () => {
    // Arrange: one clean session that touched the pinned file, one reaped
    // session that touched something else entirely
    const { harness, viewerId } = await seed();
    await insertSession(harness, viewerId, {
      id: "ses_clean",
      lastHeartbeatAt: at(-30 * MINUTE_MS),
      endedAt: at(-29 * MINUTE_MS),
    });
    await insertTouch(harness, "ses_clean", "wc_clean", "src/auth.ts");
    await insertSession(harness, viewerId, {
      id: "ses_abandoned",
      lastHeartbeatAt: at(-35 * MINUTE_MS),
      endedAt: at(-34 * MINUTE_MS),
      reapedAt: at(-34 * MINUTE_MS),
    });
    await insertTouch(harness, "ses_abandoned", "wc_abandoned", "docs/README.md");
    const deps = { db: harness.db, now: harness.clock.now };

    // Act
    const wide = await readCoverage(deps, viewerId, REPO);
    const scoped = await readCoverage(deps, viewerId, REPO, {
      scope: { sinceIso: at(-60 * MINUTE_MS).toISOString(), paths: ["src/auth.ts"] },
    });

    // Assert
    expect(
      wide.sources.find((row) => row.source === "agent_event")?.state,
    ).toBe("incomplete");
    expect(
      scoped.sources.find((row) => row.source === "agent_event")?.state,
    ).toBe("complete");
    expect(scoped.scope.paths).toEqual(["src/auth.ts"]);
  });

  test("a reaped session that DID touch the scope is still incomplete — no state is softened", async () => {
    // Arrange
    const { harness, viewerId } = await seed();
    await insertSession(harness, viewerId, {
      id: "ses_abandoned",
      lastHeartbeatAt: at(-35 * MINUTE_MS),
      endedAt: at(-34 * MINUTE_MS),
      reapedAt: at(-34 * MINUTE_MS),
    });
    await insertTouch(harness, "ses_abandoned", "wc_abandoned", "src/auth.ts");

    // Act
    const scoped = await readCoverage(
      { db: harness.db, now: harness.clock.now },
      viewerId,
      REPO,
      { scope: { sinceIso: at(-60 * MINUTE_MS).toISOString(), paths: ["src/auth.ts"] } },
    );
    const row = scoped.sources.find((entry) => entry.source === "agent_event");

    // Assert
    expect(row?.state).toBe("incomplete");
    expect(row?.reason).toBe("session_reaped");
  });

  test("sinceIso is a floor, never a way to look further back than the window", async () => {
    // Arrange: a reaped session twenty days old, and a caller asking about
    // the last ninety days
    const { harness, viewerId } = await seed();
    await insertSession(harness, viewerId, {
      id: "ses_ancient",
      lastHeartbeatAt: at(-20 * DAY_MS),
      endedAt: at(-20 * DAY_MS),
      reapedAt: at(-20 * DAY_MS),
    });

    // Act
    const scoped = await readCoverage(
      { db: harness.db, now: harness.clock.now },
      viewerId,
      REPO,
      { scope: { sinceIso: at(-90 * DAY_MS).toISOString() } },
    );

    // Assert: the hub holds no observation older than its own window to be
    // honest about, so the ceiling wins and the ancient reap is out of scope.
    expect(
      scoped.sources.find((row) => row.source === "agent_event")?.state,
    ).toBe("unknown");
    expect(Date.parse(scoped.scope.sinceIso)).toBeGreaterThan(
      new Date(TEST_START_ISO).getTime() - 15 * DAY_MS,
    );
  });
});

/**
 * §3.5's sixth response, and the one where an unqualified answer costs the
 * most: a name. 04 renders this record on the suspect verdict, and it is
 * scoped to the pin's file set so the gap it reads is a gap about the pinned
 * surface rather than about the repo.
 */
describe("GET /api/suspect carries coverage scoped to the files asked about", () => {
  test("the record names the paths the question was about", async () => {
    // Arrange: a clean session on the pinned file, a reaped one elsewhere
    const { harness, viewerId } = await seed();
    await insertSession(harness, viewerId, {
      id: "ses_clean",
      lastHeartbeatAt: at(-30 * MINUTE_MS),
      endedAt: at(-29 * MINUTE_MS),
    });
    await insertTouch(harness, "ses_clean", "wc_clean", "src/auth.ts");
    await insertSession(harness, viewerId, {
      id: "ses_abandoned",
      lastHeartbeatAt: at(-35 * MINUTE_MS),
      endedAt: at(-34 * MINUTE_MS),
      reapedAt: at(-34 * MINUTE_MS),
    });
    await insertTouch(harness, "ses_abandoned", "wc_abandoned", "docs/README.md");

    // Act
    const response = await harness.app.request(
      `/api/suspect?repo=${encodeURIComponent(REPO)}&path=src%2Fauth.ts`,
      jsonRequest("GET", apiKeys.get(viewerId) ?? null),
    );
    const body = (await response.json()) as {
      data: {
        coverage: {
          scope: { paths?: string[] };
          sources: { source: string; state: string }[];
        };
      };
    };

    // Assert
    expect(response.status).toBe(200);
    expect(body.data.coverage.scope.paths).toEqual(["src/auth.ts"]);
    expect(
      body.data.coverage.sources.find((row) => row.source === "agent_event")
        ?.state,
    ).toBe("complete");
    expect(body.data.coverage.sources.length).toBe(5);
  });
});
