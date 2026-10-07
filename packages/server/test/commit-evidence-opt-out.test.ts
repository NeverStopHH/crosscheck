/**
 * AN OPTED-OUT COLLECTOR'S COMMIT EVIDENCE COUNTS (review round 5, C1).
 *
 * Ken's newest commit is known only from Robin's SessionStart; Nick's older
 * report already holds the (repo, ken) row. Round 4 kept her report from
 * replacing Nick's and counted told collectors only — so the git rung read
 * COMPLETE for everyone, her included, while Ken's commit went unreported:
 * withheld evidence made coverage look better, which principle 5 forbids.
 *
 * Her rows now count toward the rung's state and the absence findings
 * exactly as anyone's; only the INSTANT she collected them is withheld from
 * a viewer she is hidden from. (The reviewer's zz-probe-absence.test.ts.)
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { LOCATION_WITHHELD } from "@crosscheck/schema";

import {
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";
import { setPresenceOptOutViaApi } from "./ui-helpers.ts";

const REPO = "github.com/acme/api";
const DAY_SECONDS = 86_400;
const HOUR_MS = 3_600_000;
const COLLECTION_GAP_SECONDS = 600;

interface Read {
  readonly absences: readonly { readonly kind: string; readonly name: string; readonly evidenceCollectedAt: string }[];
  readonly git: { readonly state: string; readonly reason: string; readonly observedAt: string | null } | undefined;
}

interface World {
  readonly harness: TestHarness;
  readonly nick: TestDeveloper;
  readonly ken: TestDeveloper;
  readonly robin: TestDeveloper;
  /** When Robin's SessionStart collected — hers to withhold. */
  readonly robinCollectedAt: string;
}

const evidence = (collectedAt: Date, latestCommitAt: Date, commitCount: number): Record<string, unknown> => ({
  repo: REPO,
  collectedAt: collectedAt.toISOString(),
  windowDays: 14,
  authors: [{ name: "Ken", email: "ken@example.com", latestCommitAt: latestCommitAt.toISOString(), commitCount }],
});

const seed = async (robinOptsOut: boolean): Promise<World> => {
  const harness = await createTestHarness();
  const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
  const ken = await createTestDeveloper(harness, "Ken", "ken@example.com");
  const robin = await createTestDeveloper(harness, "Robin", "robin@example.com");
  await registerTestSession(harness, nick.apiKey, { id: "cc_nick", branch: "fix/n", baseCommit: "aaaabbbbcccc" });
  await registerTestSession(harness, ken.apiKey, { id: "cc_ken", branch: "main", baseCommit: "111122223333" });
  await registerTestSession(harness, robin.apiKey, { id: "cc_robin", branch: "fix/r", baseCommit: "c0ffee000000" });
  if (robinOptsOut) {
    await setPresenceOptOutViaApi(harness, robin.apiKey, true);
  }
  harness.clock.advanceSeconds(3 * DAY_SECONDS);
  // Ken's agent last ran three days ago.
  await harness.db.execute(
    sql`UPDATE agent_sessions SET last_heartbeat_at = ${new Date(harness.clock.now().getTime() - 3 * DAY_SECONDS * 1000).toISOString()}, status = 'done' WHERE id = 'cc_ken'`,
  );
  // Nick's SessionStart, from a stale clone: Ken's last commit four days ago.
  await registerTestSession(harness, nick.apiKey, { id: "cc_nick2", branch: "fix/n", baseCommit: "aaaabbbbcccc" });
  const nickAt = harness.clock.now();
  await postRecords(harness, nick, {
    records: [recordEnvelope("commit_evidence", evidence(nickAt, new Date(nickAt.getTime() - 4 * DAY_SECONDS * 1000), 1), { sessionId: "cc_nick2" })],
  });
  harness.clock.advanceSeconds(COLLECTION_GAP_SECONDS);
  // Robin's SessionStart, from a fresh clone: Ken committed an hour ago.
  await registerTestSession(harness, robin.apiKey, { id: "cc_robin2", branch: "fix/r", baseCommit: "c0ffee000000" });
  const robinAt = harness.clock.now();
  const posted = await postRecords(harness, robin, {
    records: [recordEnvelope("commit_evidence", evidence(robinAt, new Date(robinAt.getTime() - HOUR_MS), 5), { sessionId: "cc_robin2" })],
  });
  expect(posted.data?.rejected).toBe(0);
  return { harness, nick, ken, robin, robinCollectedAt: robinAt.toISOString() };
};

const read = async (world: World, who: TestDeveloper): Promise<Read> => {
  const response = await world.harness.app.request(`/api/absences?repo=${encodeURIComponent(REPO)}`, jsonRequest("GET", who.apiKey));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: { absences: Read["absences"]; coverage: { sources: readonly ({ source: string } & NonNullable<Read["git"]>)[] } } };
  return { absences: body.data.absences, git: body.data.coverage.sources.find((row) => row.source === "git") };
};

describe("an opted-out collector's commit evidence counts for everyone", () => {
  test.each([[false], [true]] as const)("Robin opted out: %p — every reader sees the rung incomplete and Ken inactive", async (robinOptsOut) => {
    const world = await seed(robinOptsOut);

    for (const who of [world.nick, world.ken, world.robin]) {
      const seen = await read(world, who);
      expect(seen.git).toMatchObject({ state: "incomplete", reason: "commit_authors_unreported" });
      expect(seen.absences.map((finding) => `${finding.kind} ${finding.name}`)).toContain("inactive Ken");
    }
  });

  test("only WHEN she collected is withheld — from a colleague, never from herself", async () => {
    const world = await seed(true);

    const nick = await read(world, world.nick);
    const own = await read(world, world.robin);
    const kenFor = (seen: Read) => seen.absences.find((finding) => finding.name === "Ken");

    expect(kenFor(nick)?.evidenceCollectedAt).toBe(LOCATION_WITHHELD);
    expect(JSON.stringify(nick)).not.toContain(world.robinCollectedAt);
    expect(kenFor(own)?.evidenceCollectedAt).toBe(world.robinCollectedAt);
  });
});
