/**
 * MIXED VERSIONS (review round 5, H4). Round 4 named an opted-out teammate's
 * gap with a new reason, `session_withheld`. A connector released at 0.10.0
 * has no such word: its parse reads the row as unknown / hub_did_not_report,
 * the agent rung's fragment goes, and with the git rung complete its caveat
 * on a non-empty answer disappears altogether (the reviewer's
 * compat-coverage.ts). Every teammate still on 0.10.0 read a team where SOME
 * session went quiet as fully watched.
 *
 * So the wire keeps a word every released client already reads as a gap,
 * `session_silent`, and the nuance rides beside it in an ADDITIVE field,
 * `withheld: true`, which an old client ignores and a new one renders as
 * «went quiet (withheld: presence opt-out)». The old client here is the
 * 0.10.0 code itself, vendored (connector-core/test/fixtures/compat/
 * connector-0.10.0), reading what this hub sends.
 */
import { describe, expect, test } from "bun:test";

import { parseCoverage as parseCoverage010 } from "../../connector-core/test/fixtures/compat/connector-0.10.0/http/coverage.ts";
import {
  coverageNote as coverageNote010,
  mustQualifyEmptyAnswer as mustQualifyEmptyAnswer010,
} from "../../connector-core/test/fixtures/compat/connector-0.10.0/coverage/render.ts";
import { parseCoverage } from "../../connector-core/src/http/coverage.ts";
import { coverageNote, mustQualifyEmptyAnswer } from "../../connector-core/src/coverage/render.ts";
import {
  VALID_SESSION_BODY,
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
} from "./helpers.ts";

const HOUR_SECONDS = 3600;
const ABSENCES_URL = `/api/absences?repo=${encodeURIComponent(VALID_SESSION_BODY.repo)}`;

/** What the hub sends Nick when the only gap is Ken's, and Ken opted out. */
const hubSaysToNick = async (): Promise<{ readonly coverage: unknown; readonly now: Date }> => {
  const harness = await createTestHarness();
  const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
  const ken = await createTestDeveloper(harness, "Ken", "ken@example.com");
  const optOut = await harness.app.request("/api/settings/presence", jsonRequest("PUT", ken.apiKey, { optOut: true }));
  expect(optOut.status).toBe(200);
  await registerTestSession(harness, ken.apiKey, { id: "ses_ken" });
  harness.clock.advanceSeconds(HOUR_SECONDS);
  await registerTestSession(harness, nick.apiKey, { id: "ses_nick" });
  // Nick's SessionStart saw only his own commits: the git rung is complete,
  // so the agent rung is the whole caveat.
  const evidence = await postRecords(harness, nick, {
    records: [
      recordEnvelope("commit_evidence", {
        repo: VALID_SESSION_BODY.repo,
        collectedAt: harness.clock.now().toISOString(),
        windowDays: 14,
        authors: [{ name: "Nick", email: "nick@example.com", latestCommitAt: harness.clock.now().toISOString(), commitCount: 1 }],
      }, { sessionId: "ses_nick" }),
    ],
  });
  expect(evidence.data?.rejected).toBe(0);
  const response = await harness.app.request(ABSENCES_URL, jsonRequest("GET", nick.apiKey));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: { coverage: unknown } };
  return { coverage: body.data.coverage, now: harness.clock.now() };
};

describe("an opted-out teammate's gap, read by the connector a teammate runs", () => {
  test("a 0.10.0 connector still reads the rung as a gap and keeps the caveat", async () => {
    // Arrange
    const { coverage, now } = await hubSaysToNick();

    // Act
    const record = parseCoverage010(coverage);

    // Assert: incomplete, in a word it knows; the caveat on a non-empty
    // answer is there and says some agent session went quiet.
    expect(record.sources.find((row) => row.source === "agent_event")).toMatchObject({ state: "incomplete", reason: "session_silent", gapSince: null });
    expect(coverageNote010(record, now)).toContain("Coverage incomplete: agent sessions on this repo went quiet");
    expect(mustQualifyEmptyAnswer010(record)).toBe(true);
  });

  test("this connector says the gap is withheld, not how the session went quiet", async () => {
    // Arrange
    const { coverage, now } = await hubSaysToNick();

    // Act
    const record = parseCoverage(coverage);
    const note = coverageNote(record, now);

    // Assert
    expect(note).toContain("agent sessions on this repo went quiet (withheld: presence opt-out)");
    expect(note).not.toContain("unclosed");
    expect(mustQualifyEmptyAnswer(record)).toBe(true);
  });
});
