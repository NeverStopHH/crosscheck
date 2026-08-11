/**
 * Mute enforcement (DESIGN.md §2.1 "per-developer presence opt-out and
 * `mute`"): a reader's mute of developer X suppresses X's content from the
 * reader's UNASKED surfaces only — prompt-hint candidates, the tripwire, the
 * presence list, and the briefing pointer feeds (work contexts, solved
 * matches, contradictions, absence lines). Deliberate pulls (search,
 * diagnosis, referee brief) stay unfiltered, and the filter is per READER:
 * a third developer's view is untouched.
 *
 * Enforcement is HUB-side, inside each bounded query's WHERE — the crowding
 * test pins that a muted developer's rows cannot fill a bounded pool and
 * push an includable row out of it.
 *
 * TELEMETRY HONESTY rides on hub-side enforcement structurally: the
 * connector records a hint_deliveries row only for the hint it actually
 * injected (hooks/user-prompt-submit.ts recordDelivery), so a candidate this
 * filter suppressed never reaches the selector and no delivery is recorded —
 * the "candidates suppressed" pins below are the hub half of that argument.
 */
import { describe, expect, test } from "bun:test";

import {
  createTestHarness,
  createTestDeveloper,
  fetchPresence,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  validClaimBody,
  validWorkContextBody,
  VALID_SESSION_BODY,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = VALID_SESSION_BODY.repo;
const TARGET_FILE = "src/auth/refresh.ts";

const muteRef = async (
  harness: TestHarness,
  reader: TestDeveloper,
  ref: string,
): Promise<void> => {
  const response = await harness.app.request(
    "/api/settings/mutes",
    jsonRequest("POST", reader.apiKey, { developer: ref }),
  );
  expect(response.status).toBe(200);
};

const unmuteRef = async (
  harness: TestHarness,
  reader: TestDeveloper,
  ref: string,
): Promise<void> => {
  const response = await harness.app.request(
    `/api/settings/mutes/${encodeURIComponent(ref)}`,
    jsonRequest("DELETE", reader.apiKey),
  );
  expect(response.status).toBe(200);
};

interface SeededAuthor {
  readonly developer: TestDeveloper;
  readonly sessionId: string;
  readonly workContextId: string;
}

/** A developer with a session and one file-targeting context + claim. */
const seedAuthor = async (
  harness: TestHarness,
  name: string,
  email: string,
  suffix: string,
  claimOverrides: Record<string, unknown> = {},
): Promise<SeededAuthor> => {
  const developer = await createTestDeveloper(harness, name, email);
  const sessionId = `ses_${suffix}`;
  const workContextId = `wc_${suffix}`;
  await registerTestSession(harness, developer.apiKey, { id: sessionId });
  const seeded = await postRecords(harness, developer, {
    records: [
      recordEnvelope(
        "work_context",
        validWorkContextBody({ id: workContextId, sessionId }),
        { sessionId },
      ),
      recordEnvelope(
        "target",
        { workContextId, kind: "file", value: TARGET_FILE },
        { sessionId },
      ),
      recordEnvelope(
        "claim",
        validClaimBody({
          id: `clm_${suffix}`,
          workContextId,
          authorSessionId: sessionId,
          ...claimOverrides,
        }),
        { sessionId },
      ),
    ],
  });
  expect(seeded.data?.accepted).toBe(3);
  return { developer, sessionId, workContextId };
};

interface CandidateView {
  readonly workContext: { readonly id: string };
  readonly claims: readonly { readonly id: string }[];
}

const fetchCandidates = async (
  harness: TestHarness,
  reader: TestDeveloper,
  query: string,
): Promise<readonly CandidateView[]> => {
  const params = new URLSearchParams({ query, repo: REPO });
  const response = await harness.app.request(
    `/api/hints/candidates?${params.toString()}`,
    jsonRequest("GET", reader.apiKey),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    data: { candidates: readonly CandidateView[] };
  };
  return body.data.candidates;
};

describe("mute: hint candidates", () => {
  test("a muted developer's contexts leave MY candidates; unmute restores; a third reader is untouched", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    await seedAuthor(harness, "Robin", "robin@example.com", "robin");
    const clara = await createTestDeveloper(
      harness,
      "Clara",
      "clara@example.com",
    );
    const before = await fetchCandidates(harness, nick, TARGET_FILE);
    expect(before.map((entry) => entry.workContext.id)).toEqual(["wc_robin"]);

    // Act
    await muteRef(harness, nick, "Robin");

    // Assert: suppressed for Nick — and therefore no delivery the connector
    // could record (telemetry honesty, see header) — visible to Clara.
    expect(await fetchCandidates(harness, nick, TARGET_FILE)).toEqual([]);
    const claraView = await fetchCandidates(harness, clara, TARGET_FILE);
    expect(claraView.map((entry) => entry.workContext.id)).toEqual([
      "wc_robin",
    ]);

    // Act + Assert: unmute restores
    await unmuteRef(harness, nick, "Robin");
    const restored = await fetchCandidates(harness, nick, TARGET_FILE);
    expect(restored.map((entry) => entry.workContext.id)).toEqual(["wc_robin"]);
  });

  test("a muted developer's claim inside an unmuted teammate's tree is filtered from MY candidates", async () => {
    // Arrange: Clara owns the context; Robin extended it with his own claim
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    const clara = await seedAuthor(
      harness,
      "Clara",
      "clara@example.com",
      "clara",
    );
    const robin = await createTestDeveloper(
      harness,
      "Robin",
      "robin@example.com",
    );
    await registerTestSession(harness, robin.apiKey, { id: "ses_robin" });
    const extended = await postRecords(harness, robin, {
      records: [
        recordEnvelope(
          "claim",
          validClaimBody({
            id: "clm_robin_ext",
            workContextId: clara.workContextId,
            authorSessionId: "ses_robin",
            body: "Robin's extension of Clara's tree",
          }),
          { sessionId: "ses_robin" },
        ),
      ],
    });
    expect(extended.data?.accepted).toBe(1);

    // Act
    await muteRef(harness, nick, "Robin");

    // Assert: Clara's context still surfaces, Robin's claim inside it does not
    const candidates = await fetchCandidates(harness, nick, TARGET_FILE);
    expect(candidates.map((entry) => entry.workContext.id)).toEqual([
      "wc_clara",
    ]);
    expect(candidates[0]?.claims.map((claim) => claim.id)).toEqual([
      "clm_clara",
    ]);
  });

  test("a muted developer's rows cannot crowd an includable context out of the bounded pool", async () => {
    // Arrange: Robin owns three fresher contexts on the same file, Clara one.
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    await seedAuthor(harness, "Clara", "clara@example.com", "clara");
    const robin = await createTestDeveloper(
      harness,
      "Robin",
      "robin@example.com",
    );
    await registerTestSession(harness, robin.apiKey, { id: "ses_robin" });
    const suffixes = ["r1", "r2", "r3"];
    const seeded = await postRecords(harness, robin, {
      records: suffixes.flatMap((suffix) => [
        recordEnvelope(
          "work_context",
          validWorkContextBody({ id: `wc_${suffix}`, sessionId: "ses_robin" }),
          { sessionId: "ses_robin" },
        ),
        recordEnvelope(
          "target",
          { workContextId: `wc_${suffix}`, kind: "file", value: TARGET_FILE },
          { sessionId: "ses_robin" },
        ),
      ]),
    });
    expect(seeded.data?.accepted).toBe(suffixes.length * 2);

    // Act
    await muteRef(harness, nick, "Robin");

    // Assert: filtering happened inside the query's WHERE, so Clara's context
    // takes a slot instead of being crowded out by three muted rows.
    const candidates = await fetchCandidates(harness, nick, TARGET_FILE);
    expect(candidates.map((entry) => entry.workContext.id)).toEqual([
      "wc_clara",
    ]);
  });
});

describe("mute: tripwire and presence", () => {
  test("a muted developer's sessions leave MY tripwire and presence, not a third reader's", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    const clara = await createTestDeveloper(
      harness,
      "Clara",
      "clara@example.com",
    );
    await seedAuthor(harness, "Robin", "robin@example.com", "robin");

    // Act
    await muteRef(harness, nick, "Robin");

    // Assert: tripwire silent for Nick, loud for Clara
    const params = new URLSearchParams({ repo: REPO, value: TARGET_FILE });
    const nickWire = await harness.app.request(
      `/api/hints/tripwire?${params.toString()}`,
      jsonRequest("GET", nick.apiKey),
    );
    const nickBody = (await nickWire.json()) as {
      data: { sessions: readonly unknown[] };
    };
    expect(nickBody.data.sessions).toEqual([]);
    const claraWire = await harness.app.request(
      `/api/hints/tripwire?${params.toString()}`,
      jsonRequest("GET", clara.apiKey),
    );
    const claraBody = (await claraWire.json()) as {
      data: { sessions: readonly { sessionId: string }[] };
    };
    expect(claraBody.data.sessions.map((entry) => entry.sessionId)).toEqual([
      "ses_robin",
    ]);

    // Assert: presence hides Robin for Nick only
    const nickPresence = await fetchPresence(harness, nick.apiKey);
    expect(nickPresence.sessions).toEqual([]);
    const claraPresence = await fetchPresence(harness, clara.apiKey);
    expect(
      claraPresence.sessions.map((entry) => entry.developerName),
    ).toEqual(["Robin"]);
  });
});

describe("mute: briefing pointer feeds", () => {
  test("work-contexts listing and solved matches drop a muted author's rows for the muting reader only", async () => {
    // Arrange: Robin's context is SOLVED (likely_root_cause + evidence) and
    // shares its file target with Nick's own live context.
    const harness = await createTestHarness();
    const robin = await seedAuthor(
      harness,
      "Robin",
      "robin@example.com",
      "robin",
      {
        kind: "root_cause",
        status: "likely_root_cause",
        evidenceRefs: ["clm_evidence"],
      },
    );
    const nick = await seedAuthor(harness, "Nick", "nick@example.com", "nick");
    const clara = await createTestDeveloper(
      harness,
      "Clara",
      "clara@example.com",
    );

    const fetchContexts = async (
      reader: TestDeveloper,
    ): Promise<readonly string[]> => {
      const response = await harness.app.request(
        `/api/work-contexts?repo=${encodeURIComponent(REPO)}`,
        jsonRequest("GET", reader.apiKey),
      );
      const body = (await response.json()) as {
        data: { workContexts: readonly { id: string }[] };
      };
      return body.data.workContexts.map((entry) => entry.id);
    };
    const fetchSolved = async (
      reader: TestDeveloper,
    ): Promise<readonly string[]> => {
      const response = await harness.app.request(
        `/api/solved-matches?repo=${encodeURIComponent(REPO)}`,
        jsonRequest("GET", reader.apiKey),
      );
      const body = (await response.json()) as {
        data: { matches: readonly { workContextId: string }[] };
      };
      return body.data.matches.map((entry) => entry.workContextId);
    };
    expect(await fetchSolved(nick.developer)).toEqual([robin.workContextId]);

    // Act
    await muteRef(harness, nick.developer, "Robin");

    // Assert
    expect(await fetchContexts(nick.developer)).toEqual([nick.workContextId]);
    expect(await fetchSolved(nick.developer)).toEqual([]);
    expect([...(await fetchContexts(clara))].sort()).toEqual(
      [nick.workContextId, robin.workContextId].sort(),
    );
  });

  test("contradiction pointers naming a muted author leave MY listing; the referee brief still resolves by id", async () => {
    // Arrange: Robin holds an open hypothesis, Nick a rejected one, targets
    // shared — the derived two-developer deadlock.
    const harness = await createTestHarness();
    await seedAuthor(harness, "Robin", "robin@example.com", "robin", {
      kind: "hypothesis",
      status: "proposed",
    });
    const nick = await seedAuthor(harness, "Nick", "nick@example.com", "nick", {
      kind: "hypothesis",
      status: "rejected",
    });

    const fetchContradictions = async (
      reader: TestDeveloper,
    ): Promise<readonly { id: string }[]> => {
      const response = await harness.app.request(
        `/api/contradictions?repo=${encodeURIComponent(REPO)}`,
        jsonRequest("GET", reader.apiKey),
      );
      const body = (await response.json()) as {
        data: { candidates: readonly { id: string }[] };
      };
      return body.data.candidates;
    };
    const before = await fetchContradictions(nick.developer);
    expect(before.length).toBe(1);
    const pairId = before[0]?.id ?? "";

    // Act
    await muteRef(harness, nick.developer, "Robin");

    // Assert: the pointer is gone from the muting reader's listing...
    expect(await fetchContradictions(nick.developer)).toEqual([]);
    // ...but the deliberate pull by id still answers (mute is not a boundary)
    const brief = await harness.app.request(
      `/api/contradictions/${encodeURIComponent(pairId)}/brief`,
      jsonRequest("GET", nick.developer.apiKey),
    );
    expect(brief.status).toBe(200);
  });

  test("absence lines about a muted member leave MY reads only", async () => {
    // Arrange: Robin is a member with commits and no session on the repo
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    await registerTestSession(harness, nick.apiKey);
    await createTestDeveloper(harness, "Robin", "robin@example.com");
    const clara = await createTestDeveloper(
      harness,
      "Clara",
      "clara@example.com",
    );
    const ingest = await postRecords(harness, nick, {
      records: [
        recordEnvelope("commit_evidence", {
          repo: REPO,
          collectedAt: "2026-07-24T09:00:00.000Z",
          windowDays: 14,
          authors: [
            {
              name: "robin-git",
              email: "robin@example.com",
              latestCommitAt: "2026-07-22T09:00:00.000Z",
              commitCount: 7,
            },
          ],
        }),
      ],
    });
    expect(ingest.data?.accepted).toBe(1);

    const fetchAbsenceNames = async (
      reader: TestDeveloper,
    ): Promise<readonly string[]> => {
      const response = await harness.app.request(
        `/api/absences?repo=${encodeURIComponent(REPO)}`,
        jsonRequest("GET", reader.apiKey),
      );
      const body = (await response.json()) as {
        data: { absences: readonly { name: string }[] };
      };
      return body.data.absences.map((entry) => entry.name);
    };
    expect(await fetchAbsenceNames(nick)).toEqual(["Robin"]);

    // Act
    await muteRef(harness, nick, "Robin");

    // Assert
    expect(await fetchAbsenceNames(nick)).toEqual([]);
    expect(await fetchAbsenceNames(clara)).toEqual(["Robin"]);
  });
});

describe("mute never blocks the deliberate pull", () => {
  test("search and the diagnosis tree still serve a muted developer's knowledge", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    const robin = await seedAuthor(
      harness,
      "Robin",
      "robin@example.com",
      "robin",
    );

    // Act
    await muteRef(harness, nick, "Robin");

    // Assert: search_related_work's endpoint is a pull — unfiltered
    const params = new URLSearchParams({ query: TARGET_FILE, repo: REPO });
    const search = await harness.app.request(
      `/api/search?${params.toString()}`,
      jsonRequest("GET", nick.apiKey),
    );
    const searchBody = (await search.json()) as {
      data: { results: readonly { id: string }[] };
    };
    expect(searchBody.data.results.map((row) => row.id)).toEqual([
      robin.workContextId,
    ]);

    // Assert: get_diagnosis is a pull — unfiltered, fully attributed
    const diagnosis = await harness.app.request(
      `/api/work-contexts/${robin.workContextId}/diagnosis`,
      jsonRequest("GET", nick.apiKey),
    );
    expect(diagnosis.status).toBe(200);
    const diagnosisBody = (await diagnosis.json()) as {
      data: { claims: readonly { authorDeveloperName: string }[] };
    };
    expect(
      diagnosisBody.data.claims.map((claim) => claim.authorDeveloperName),
    ).toEqual(["Robin"]);
  });
});
