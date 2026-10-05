/**
 * REVIEW OF H3, FINDING 4: a coverage instant is presence. `gapSince`,
 * `observedAt` and the loss instant are heartbeats and ledger times — "when
 * somebody last ran an agent", which presence opt-out hides from everyone
 * but its subject (services/visibility.ts). A session of a developer the
 * viewer may not be told about still WEAKENS the agent_event state — the gap
 * is real whoever had it — but lends the record no instant.
 *
 * The named-session arm made this reachable on a pull surface: get_diagnosis
 * names the claim author's session, and its `gapSince` was the opted-out
 * author's last heartbeat. The window arm had the same channel already:
 * `/api/absences` carried an opted-out teammate's newest heartbeat as
 * `observedAt`.
 *
 * AND WITHHOLDING MUST NEVER STATE A LATER START (final review). `gapSince`
 * is the EARLIEST instant: dropping a hidden session's earlier one and
 * printing a told session's later one states a later start than the truth,
 * so a hidden gap or loss withholds the field. `observedAt` is the newest
 * heartbeat the viewer may be told about: older than the truth when a hidden
 * session is newer, which can only make the rung look staler.
 */
import { describe, expect, test } from "bun:test";

import type { CoverageRecord, CoverageSourceRecord } from "../src/services/coverage.ts";
import {
  VALID_SESSION_BODY,
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  validClaimBody,
  validWorkContextBody,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = VALID_SESSION_BODY.repo;
const HOUR_SECONDS = 3600;
const DAY_SECONDS = 24 * HOUR_SECONDS;

const seed = async (): Promise<{ harness: TestHarness; nick: TestDeveloper; ken: TestDeveloper }> => {
  const harness = await createTestHarness();
  const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
  const ken = await createTestDeveloper(harness, "Ken", "ken@example.com");
  const optOut = await harness.app.request(
    "/api/settings/presence",
    jsonRequest("PUT", ken.apiKey, { optOut: true }),
  );
  expect(optOut.status).toBe(200);
  return { harness, nick, ken };
};

const endCleanly = async (harness: TestHarness, developer: TestDeveloper, id: string): Promise<void> => {
  const response = await harness.app.request(
    `/api/sessions/${id}/end`,
    jsonRequest("POST", developer.apiKey, { status: "done" }),
  );
  expect(response.status).toBe(200);
};

const dataOf = async <T>(harness: TestHarness, developer: TestDeveloper, url: string): Promise<T> => {
  const response = await harness.app.request(url, jsonRequest("GET", developer.apiKey));
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: T }).data;
};

const agentEventOf = (record: CoverageRecord): CoverageSourceRecord => {
  const row = record.sources.find((entry) => entry.source === "agent_event");
  if (row === undefined) {
    throw new Error("agent_event row missing");
  }
  return row;
};

const absencesUrl = `/api/absences?repo=${encodeURIComponent(REPO)}`;

describe("a session the viewer may not be told about weakens the rung and lends it no instant", () => {
  test("get_diagnosis: an opted-out claim author's quiet session gaps the tree, with no instant of his", async () => {
    // Arrange: Nick's tree; Ken, opted out, wrote a claim into it and went
    // quiet; twenty days later Nick reads it from a fresh session.
    const { harness, nick, ken } = await seed();
    await registerTestSession(harness, nick.apiKey, { id: "ses_nick" });
    await postRecords(harness, nick, {
      records: [
        recordEnvelope("work_context", validWorkContextBody({ id: "wc_n", sessionId: "ses_nick" }), {
          sessionId: "ses_nick",
        }),
      ],
    });
    await endCleanly(harness, nick, "ses_nick");
    harness.clock.advanceSeconds(3 * HOUR_SECONDS);
    await registerTestSession(harness, ken.apiKey, { id: "ses_ken" });
    await postRecords(harness, ken, {
      records: [
        recordEnvelope("claim", validClaimBody({ workContextId: "wc_n", authorSessionId: "ses_ken" }), {
          sessionId: "ses_ken",
        }),
      ],
    });
    harness.clock.advanceSeconds(20 * DAY_SECONDS);
    await registerTestSession(harness, nick.apiKey, { id: "ses_nick2" });
    // Act
    const data = await dataOf<{ coverage: CoverageRecord }>(
      harness,
      nick,
      "/api/work-contexts/wc_n/diagnosis?telemetry=0",
    );
    // Assert
    expect(agentEventOf(data.coverage)).toEqual({
      source: "agent_event",
      state: "incomplete",
      reason: "session_silent",
      gapSince: null,
      observedAt: harness.clock.now().toISOString(),
    });
  });

  test("/api/absences: an opted-out teammate's newest heartbeat is not the rung's observedAt", async () => {
    // Arrange: Nick reported an hour ago and ended; Ken, opted out, is live now.
    const { harness, nick, ken } = await seed();
    await registerTestSession(harness, nick.apiKey, { id: "ses_nick" });
    const nickHeartbeat = harness.clock.now().toISOString();
    await endCleanly(harness, nick, "ses_nick");
    harness.clock.advanceSeconds(HOUR_SECONDS);
    await registerTestSession(harness, ken.apiKey, { id: "ses_ken" });
    // Act
    const nickView = await dataOf<{ coverage: CoverageRecord }>(harness, nick, absencesUrl);
    const kenView = await dataOf<{ coverage: CoverageRecord }>(harness, ken, absencesUrl);
    // Assert: hidden from Nick; Ken's own view of himself is unaffected.
    expect(agentEventOf(nickView.coverage)).toMatchObject({ state: "complete", observedAt: nickHeartbeat });
    expect(agentEventOf(kenView.coverage).observedAt).toBe(harness.clock.now().toISOString());
  });

  test("an opted-out teammate's loss makes the rung incomplete, and its instant stays his", async () => {
    // Arrange
    const { harness, nick, ken } = await seed();
    await registerTestSession(harness, nick.apiKey, { id: "ses_nick" });
    const lossAt = new Date(harness.clock.now().getTime() - DAY_SECONDS * 1000).toISOString();
    await registerTestSession(harness, ken.apiKey, {
      id: "ses_ken",
      losses: { total: 5, kinds: { spool_expired: 5 }, oldestAt: lossAt, newestAt: lossAt },
    });
    // Act
    const data = await dataOf<{ coverage: CoverageRecord }>(harness, nick, absencesUrl);
    // Assert
    expect(agentEventOf(data.coverage)).toMatchObject({
      state: "incomplete",
      reason: "telemetry_lost",
      gapSince: null,
    });
  });
});

describe("a hidden session never moves an instant the unsafe way", () => {
  test("gap: Ken, opted out, went quiet five days before Nick did — Nick's view prints no later start", async () => {
    // Arrange: both sessions stop heartbeating; Ken's stopped first.
    const { harness, nick, ken } = await seed();
    await registerTestSession(harness, ken.apiKey, { id: "ses_ken" });
    const kenQuietSince = harness.clock.now().toISOString();
    harness.clock.advanceSeconds(5 * DAY_SECONDS - HOUR_SECONDS);
    await registerTestSession(harness, nick.apiKey, { id: "ses_nick" });
    harness.clock.advanceSeconds(HOUR_SECONDS);
    // Act
    const nickView = agentEventOf((await dataOf<{ coverage: CoverageRecord }>(harness, nick, absencesUrl)).coverage);
    const kenView = agentEventOf((await dataOf<{ coverage: CoverageRecord }>(harness, ken, absencesUrl)).coverage);
    // Assert: withheld for Nick, the true earliest for Ken, who may see both.
    expect(nickView).toMatchObject({ state: "incomplete", reason: "session_silent", gapSince: null });
    expect(kenView).toMatchObject({ state: "incomplete", gapSince: kenQuietSince });
  });

  test("loss: Ken's hidden loss three days ago, Nick's own one day ago — Nick's view prints no later start", async () => {
    // Arrange
    const { harness, nick, ken } = await seed();
    const daysAgo = (days: number): string =>
      new Date(harness.clock.now().getTime() - days * DAY_SECONDS * 1000).toISOString();
    await registerTestSession(harness, ken.apiKey, {
      id: "ses_ken",
      losses: { total: 2, kinds: { spool_expired: 2 }, oldestAt: daysAgo(3), newestAt: daysAgo(3) },
    });
    await registerTestSession(harness, nick.apiKey, {
      id: "ses_nick",
      losses: { total: 2, kinds: { spool_expired: 2 }, oldestAt: daysAgo(1), newestAt: daysAgo(1) },
    });
    // Act
    const nickView = agentEventOf((await dataOf<{ coverage: CoverageRecord }>(harness, nick, absencesUrl)).coverage);
    const kenView = agentEventOf((await dataOf<{ coverage: CoverageRecord }>(harness, ken, absencesUrl)).coverage);
    // Assert
    expect(nickView).toMatchObject({ state: "incomplete", reason: "telemetry_lost", gapSince: null });
    expect(kenView).toMatchObject({ state: "incomplete", reason: "telemetry_lost", gapSince: daysAgo(3) });
  });

  test("observedAt: with Ken's hidden heartbeat newer, Nick's view carries the newest he may be told, never Ken's", async () => {
    // Arrange: Nick's live session, and Ken's newer one.
    const { harness, nick, ken } = await seed();
    await registerTestSession(harness, nick.apiKey, { id: "ses_nick" });
    const nickHeartbeat = harness.clock.now().toISOString();
    harness.clock.advanceSeconds(30);
    await registerTestSession(harness, ken.apiKey, { id: "ses_ken" });
    // Act
    const nickView = agentEventOf((await dataOf<{ coverage: CoverageRecord }>(harness, nick, absencesUrl)).coverage);
    // Assert: older than the truth, the direction that can only look staler.
    expect(nickView).toMatchObject({ state: "complete", observedAt: nickHeartbeat });
  });
});
