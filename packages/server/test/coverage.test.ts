/**
 * The coverage record's SHAPE (docs/1.0/03-coverage-integrity.md §3.1, §3.2).
 *
 * COV-2 and the data half of COV-5 live here. Both are about the same defect
 * in two directions: a rung that cannot be read must still be a ROW, and a
 * rung that cannot EXIST must not be readable as one that might.
 */
import { describe, expect, test } from "bun:test";

import { agentSessions, commitEvidence } from "../src/db/schema.ts";
import {
  COVERAGE_SOURCES,
  readCoverage,
} from "../src/services/coverage.ts";
import { TEST_START_ISO, createTestDeveloper, createTestHarness } from "./helpers.ts";
import type { TestHarness } from "./helpers.ts";

const REPO = "github.com/acme/api";
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const at = (offsetMs: number): Date =>
  new Date(new Date(TEST_START_ISO).getTime() + offsetMs);

const seed = async (): Promise<{
  harness: TestHarness;
  viewerId: string;
}> => {
  const harness = await createTestHarness();
  const developer = await createTestDeveloper(harness, "Nick", "nick@example.com");
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
