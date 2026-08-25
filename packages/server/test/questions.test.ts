import { beforeEach, describe, expect, test } from "bun:test";
import {
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
  registerTestSession,
  VALID_SESSION_BODY,
  validClaimBody,
  validWorkContextBody,
  WORK_CONTEXT_ID,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";
import { asRendered, MAX_REFUSAL_CHARS } from "../src/services/refusal.ts";

const REPO = VALID_SESSION_BODY.repo;
const SECONDS_PER_DAY = 24 * 60 * 60;

interface Party {
  readonly developer: TestDeveloper;
  readonly sessionId: string;
}

const seatDeveloper = async (
  harness: TestHarness,
  name: string,
  email: string,
  sessionId: string,
): Promise<Party> => {
  const developer = await createTestDeveloper(harness, name, email);
  const registered = await registerTestSession(harness, developer.apiKey, {
    id: sessionId,
  });
  if (registered.status !== 200) {
    throw new Error(`session ${sessionId} failed: ${String(registered.status)}`);
  }
  return { developer, sessionId };
};

const ask = async (
  harness: TestHarness,
  party: Party,
  body: Record<string, unknown>,
): Promise<Response> =>
  harness.app.request(
    "/api/questions",
    jsonRequest("POST", party.developer.apiKey, {
      id: `qn_${String(Math.random()).slice(2)}`,
      repo: REPO,
      sessionId: party.sessionId,
      ...body,
    }),
  );

const readQuestions = async (
  harness: TestHarness,
  party: Party,
): Promise<{
  readonly status: number;
  readonly data: {
    readonly inbox: readonly Record<string, unknown>[];
    readonly answers: readonly Record<string, unknown>[];
    readonly counts: Record<string, unknown>;
  };
}> => {
  const response = await harness.app.request(
    `/api/questions?repo=${encodeURIComponent(REPO)}`,
    jsonRequest("GET", party.developer.apiKey),
  );
  const body = (await response.json()) as { data?: unknown };
  return {
    status: response.status,
    data: (body.data ?? { inbox: [], answers: [], counts: {} }) as never,
  };
};

/**
 * The RECORD path (spool replay), which carries `createdAt` on the wire —
 * the axis the route path cannot exercise, because the route stamps its own.
 */
const askRecords = async (
  harness: TestHarness,
  party: Party,
  bodies: readonly Record<string, unknown>[],
): Promise<{
  readonly accepted: number;
  readonly rejected: number;
  readonly firstRejection: string;
}> => {
  const response = await harness.app.request(
    "/api/records",
    jsonRequest("POST", party.developer.apiKey, {
      records: bodies.map((body, index) => ({
        cx: "0.1",
        id: `env_q_${String(index)}`,
        ts: harness.clock.now().toISOString(),
        producer: {
          developerId: party.developer.developerId,
          agentKind: "claude-code",
          sessionId: party.sessionId,
        },
        kind: "question",
        body: {
          repo: REPO,
          authorDeveloperId: party.developer.developerId,
          authorSessionId: party.sessionId,
          ...body,
        },
      })),
    }),
  );
  const parsed = (await response.json()) as {
    data?: {
      accepted?: number;
      rejected?: number;
      results?: readonly { issues?: readonly string[] }[];
    };
  };
  const results = parsed.data?.results ?? [];
  return {
    accepted: parsed.data?.accepted ?? 0,
    rejected: parsed.data?.rejected ?? 0,
    firstRejection:
      results.find((result) => (result.issues ?? []).length > 0)?.issues?.[0] ??
      "",
  };
};

const failureOf = async (
  response: Response,
): Promise<{ readonly code: string; readonly message: string }> => {
  const body = (await response.json()) as {
    error?: { code?: string; message?: string };
  };
  return { code: body.error?.code ?? "", message: body.error?.message ?? "" };
};

describe("asking a teammate", () => {
  let harness: TestHarness;
  let nick: Party;
  let ken: Party;

  beforeEach(async () => {
    harness = await createTestHarness();
    nick = await seatDeveloper(harness, "Nick", "nick@example.com", "ses_nick");
    ken = await seatDeveloper(harness, "Ken", "ken@example.com", "ses_ken");
  });

  test("a question reaches the named teammate's inbox and nobody else's", async () => {
    // Act
    const asked = await ask(harness, nick, {
      developer: "Ken",
      body: "Did the rate-limit variant of the importer ever get tried?",
    });

    // Assert
    expect(asked.status).toBe(200);
    const kensView = await readQuestions(harness, ken);
    expect(kensView.data.inbox).toHaveLength(1);
    expect(kensView.data.inbox[0]?.["authorDeveloperName"]).toBe("Nick");
    expect(kensView.data.inbox[0]?.["body"]).toBe(
      "Did the rate-limit variant of the importer ever get tried?",
    );
    // The asker's OWN inbox stays empty — this is addressed communication,
    // not a feed both sides read.
    const nicksView = await readQuestions(harness, nick);
    expect(nicksView.data.inbox).toHaveLength(0);
    expect(nicksView.data.counts["asked"]).toBe(1);
  });

  test("an unknown name is refused by name, never answered with silence", async () => {
    // Act
    const asked = await ask(harness, nick, {
      developer: "Kenn",
      body: "Did the rate-limit variant ever get tried?",
    });

    // Assert: the R1 rule, applied to this channel — a misspelt name must not
    // read as "Ken cannot be asked".
    expect(asked.status).toBe(400);
    const failure = await failureOf(asked);
    expect(failure.code).toBe("unknown_developer");
    expect(failure.message).toContain("Ken");
  });

  test("an ambiguous name is refused with the candidate addresses", async () => {
    // Arrange
    await createTestDeveloper(harness, "Kim", "kim.a@example.com");
    await createTestDeveloper(harness, "Kim", "kim.b@example.com");

    // Act
    const asked = await ask(harness, nick, {
      developer: "Kim",
      body: "Did the rate-limit variant ever get tried?",
    });

    // Assert
    expect(asked.status).toBe(400);
    const failure = await failureOf(asked);
    expect(failure.code).toBe("ambiguous_developer");
    expect(failure.message).toContain("kim.a@example.com");
  });

  test("a question with no addressee at all is refused — never a broadcast", async () => {
    // Act
    const asked = await ask(harness, nick, {
      body: "Has anybody looked at the importer?",
    });

    // Assert
    expect(asked.status).toBe(400);
    expect((await failureOf(asked)).code).toBe("invalid_question");
  });

  test("naming only a work context asks whoever owns it", async () => {
    // Arrange: Ken files a work context; Nick asks about it without naming Ken.
    const filed = await harness.app.request(
      "/api/records",
      jsonRequest("POST", ken.developer.apiKey, {
        records: [
          {
            cx: "0.1",
            id: "env_wc",
            ts: harness.clock.now().toISOString(),
            producer: {
              developerId: ken.developer.developerId,
              agentKind: "claude-code",
              sessionId: ken.sessionId,
            },
            kind: "work_context",
            body: validWorkContextBody({ sessionId: ken.sessionId }),
          },
        ],
      }),
    );
    expect(filed.status).toBe(200);

    // Act
    const asked = await ask(harness, nick, {
      workContextId: WORK_CONTEXT_ID,
      body: "Is the 500 you are chasing the same one the importer throws?",
    });

    // Assert
    expect(asked.status).toBe(200);
    const kensView = await readQuestions(harness, ken);
    expect(kensView.data.inbox).toHaveLength(1);
    expect(kensView.data.inbox[0]?.["workContextId"]).toBe(WORK_CONTEXT_ID);
    expect(kensView.data.inbox[0]?.["workContextTitle"]).toBe(
      "Login 500s on staging",
    );
  });

  test("asking yourself is refused rather than filed", async () => {
    // Act
    const asked = await ask(harness, nick, {
      developer: "Nick",
      body: "What am I doing?",
    });

    // Assert
    expect(asked.status).toBe(400);
    expect((await failureOf(asked)).code).toBe("invalid_question");
  });

  test("the identical open question is a duplicate naming the existing id", async () => {
    // Arrange
    const first = await ask(harness, nick, {
      developer: "Ken",
      body: "Did the rate-limit variant ever get tried?",
    });
    const firstBody = (await first.json()) as {
      data: { question: { id: string } };
    };

    // Act: the same question, re-worded only in whitespace and case.
    const second = await ask(harness, nick, {
      developer: "Ken",
      body: "  did the RATE-LIMIT variant  ever get tried? ",
    });

    // Assert
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      data: { questionId: string; duplicate: boolean };
    };
    expect(secondBody.data.duplicate).toBe(true);
    expect(secondBody.data.questionId).toBe(firstBody.data.question.id);
    const kensView = await readQuestions(harness, ken);
    expect(kensView.data.inbox).toHaveLength(1);
  });

  test("the per-target budget refuses the fourth open question to one teammate", async () => {
    // Arrange: three distinct open questions to Ken.
    for (const topic of ["importer", "matcher", "scheduler"]) {
      const asked = await ask(harness, nick, {
        developer: "Ken",
        body: `Did you already try the retry path in the ${topic}?`,
      });
      expect(asked.status).toBe(200);
    }

    // Act
    const fourth = await ask(harness, nick, {
      developer: "Ken",
      body: "Did you already try the retry path in the uploader?",
    });

    // Assert
    expect(fourth.status).toBe(429);
    const failure = await failureOf(fourth);
    expect(failure.code).toBe("question_budget_reached");
    expect(failure.message).toContain("3");
  });

  test("a client cannot file a question that never expires", async () => {
    // Arrange: the wire carries status and expiresAt because a READ does;
    // ingest must ignore both, or a question could outlive its own TTL.
    const asked = await harness.app.request(
      "/api/records",
      jsonRequest("POST", nick.developer.apiKey, {
        records: [
          {
            cx: "0.1",
            id: "env_q",
            ts: harness.clock.now().toISOString(),
            producer: {
              developerId: nick.developer.developerId,
              agentKind: "claude-code",
              sessionId: nick.sessionId,
            },
            kind: "question",
            body: {
              id: "qn_forever",
              repo: REPO,
              authorDeveloperId: nick.developer.developerId,
              authorSessionId: nick.sessionId,
              targetDeveloperId: ken.developer.developerId,
              body: "Did the rate-limit variant ever get tried?",
              status: "answered",
              expiresAt: "2099-01-01T00:00:00.000Z",
              createdAt: harness.clock.now().toISOString(),
            },
          },
        ],
      }),
    );
    expect(asked.status).toBe(200);

    // Act: one day past the TTL.
    harness.clock.advanceSeconds(15 * SECONDS_PER_DAY);
    const kensView = await readQuestions(harness, ken);

    // Assert: expired away, not stored open until 2099, and not born answered.
    expect(kensView.data.inbox).toHaveLength(0);
    const nicksView = await readQuestions(harness, nick);
    expect(nicksView.data.counts["askedExpired"]).toBe(1);
    expect(nicksView.data.counts["askedAnswered"]).toBe(0);
  });

  test("a backdated question expires on the hub's clock, not the caller's", async () => {
    // Arrange: `expiresAt` is derived from `createdAt`, so a caller who owned
    // `createdAt` would own the TTL — the same hole the hub already closed for
    // `status` and `expiresAt` themselves.
    const filed = await askRecords(harness, nick, [
      {
        id: "qn_future",
        targetDeveloperId: ken.developer.developerId,
        body: "Did the rate-limit variant ever get tried?",
        createdAt: "2099-01-01T00:00:00.000Z",
      },
    ]);
    expect(filed.accepted).toBe(1);
    const stamped = await readQuestions(harness, ken);
    expect(stamped.data.inbox[0]?.["createdAt"]).not.toContain("2099");

    // Act: one day past the TTL of a question asked NOW.
    harness.clock.advanceSeconds(15 * SECONDS_PER_DAY);

    // Assert: gone from the target's inbox, and counted as expired for the
    // asker — not open in the target's briefing until the year 2099.
    const kensView = await readQuestions(harness, ken);
    expect(kensView.data.inbox).toHaveLength(0);
    const nicksView = await readQuestions(harness, nick);
    expect(nicksView.data.counts["askedExpired"]).toBe(1);
  });

  test("backdating a question does not lift the hub's budgets", async () => {
    // Arrange: a question backdated past the TTL is neither live (the two open
    // budgets and the dedup scan all read `isLive`) nor inside the rolling 24 h
    // the day probe counts — so an untrusted `createdAt` switches all three off
    // at once, and the dedup scan with them.
    const backdated = new Date(
      harness.clock.now().getTime() - 15 * SECONDS_PER_DAY * 1000,
    ).toISOString();

    // Act: ten questions to one teammate, where the per-target budget is three.
    const filed = await askRecords(
      harness,
      nick,
      Array.from({ length: 10 }, (_unused, index) => ({
        id: `qn_backdated_${String(index)}`,
        targetDeveloperId: ken.developer.developerId,
        body: `Did the retry path in importer ${String(index)} ever get tried?`,
        createdAt: backdated,
      })),
    );

    // Assert: the budget refused the surplus, in the same words the route uses.
    expect(filed.accepted).toBeLessThanOrEqual(3);
    expect(filed.rejected).toBeGreaterThan(0);
    expect(filed.firstRejection).toContain("question budget");
  });

  test("a question past the TTL leaves the inbox without any cron", async () => {
    // Arrange
    const asked = await ask(harness, nick, {
      developer: "Ken",
      body: "Did the rate-limit variant ever get tried?",
    });
    expect(asked.status).toBe(200);
    const before = await readQuestions(harness, ken);
    expect(before.data.inbox).toHaveLength(1);

    // Act
    harness.clock.advanceSeconds(15 * SECONDS_PER_DAY);

    // Assert
    const after = await readQuestions(harness, ken);
    expect(after.data.inbox).toHaveLength(0);
  });
});

describe("answering a question", () => {
  let harness: TestHarness;
  let nick: Party;
  let ken: Party;
  let mike: Party;
  let questionId: string;

  const fileKensContext = async (): Promise<void> => {
    const filed = await harness.app.request(
      "/api/records",
      jsonRequest("POST", ken.developer.apiKey, {
        records: [
          {
            cx: "0.1",
            id: "env_wc_ken",
            ts: harness.clock.now().toISOString(),
            producer: {
              developerId: ken.developer.developerId,
              agentKind: "claude-code",
              sessionId: ken.sessionId,
            },
            kind: "work_context",
            body: validWorkContextBody({
              id: "wc_ken",
              sessionId: ken.sessionId,
            }),
          },
        ],
      }),
    );
    expect(filed.status).toBe(200);
  };

  const answerAs = async (
    party: Party,
    overrides: Record<string, unknown> = {},
    id: string = questionId,
  ): Promise<Response> =>
    harness.app.request(
      `/api/questions/${id}/answers`,
      jsonRequest("POST", party.developer.apiKey, {
        claim: validClaimBody({
          id: `clm_${String(Math.random()).slice(2)}`,
          workContextId: "wc_ken",
          authorSessionId: party.sessionId,
          body: "The rate-limit variant still 429s at 40 requests per second.",
          createdAt: harness.clock.now().toISOString(),
          ...overrides,
        }),
      }),
    );

  beforeEach(async () => {
    harness = await createTestHarness();
    nick = await seatDeveloper(harness, "Nick", "nick@example.com", "ses_nick");
    ken = await seatDeveloper(harness, "Ken", "ken@example.com", "ses_ken");
    mike = await seatDeveloper(harness, "Mike", "mike@example.com", "ses_mike");
    await fileKensContext();
    const asked = await ask(harness, nick, {
      developer: "Ken",
      body: "Did the rate-limit variant of the importer ever get tried?",
    });
    const body = (await asked.json()) as { data: { question: { id: string } } };
    questionId = body.data.question.id;
  });

  test("the named teammate answers, and the answer reaches the asker", async () => {
    // Act
    const answered = await answerAs(ken);

    // Assert
    expect(answered.status).toBe(200);
    const nicksView = await readQuestions(harness, nick);
    expect(nicksView.data.answers).toHaveLength(1);
    expect(nicksView.data.answers[0]?.["claimBody"]).toBe(
      "The rate-limit variant still 429s at 40 requests per second.",
    );
    expect(nicksView.data.answers[0]?.["answererDeveloperName"]).toBe("Ken");
    expect(nicksView.data.counts["askedAnswered"]).toBe(1);
  });

  test("a third party cannot answer, and the refusal does not leak the question", async () => {
    // Act
    const answered = await answerAs(mike, {
      workContextId: "wc_ken",
      authorSessionId: mike.sessionId,
    });

    // Assert
    expect(answered.status).toBe(400);
    const failure = await failureOf(answered);
    expect(failure.code).toBe("question_not_answerable");
    // The one thing the refusal must never carry: the question's own words.
    expect(failure.message).not.toContain("rate-limit");
    // And nothing reached the asker.
    const nicksView = await readQuestions(harness, nick);
    expect(nicksView.data.answers).toHaveLength(0);
  });

  test("an id nobody ever minted is refused in the SAME words as a foreign one", async () => {
    // Arrange: telling "wrong id" from "not yours" apart would let a caller
    // enumerate the hub's questions by probing ids.
    const foreign = await answerAs(mike, {
      workContextId: "wc_ken",
      authorSessionId: mike.sessionId,
    });
    const invented = await answerAs(
      mike,
      { workContextId: "wc_ken", authorSessionId: mike.sessionId },
      "qn_nobody_minted_this",
    );

    // Act / Assert
    expect((await failureOf(foreign)).message).toBe(
      (await failureOf(invented)).message,
    );
  });

  test("the first answer flips the status and a later one still attaches", async () => {
    // Arrange
    expect((await answerAs(ken)).status).toBe(200);

    // Act: Ken corrects himself with a second answer.
    const second = await answerAs(ken, {
      body: "Correction: it 429s at 40 rps only with the shared token bucket.",
    });

    // Assert
    expect(second.status).toBe(200);
    const nicksView = await readQuestions(harness, nick);
    expect(nicksView.data.answers).toHaveLength(2);
    expect(nicksView.data.counts["askedAnswered"]).toBe(1);
  });

  test("an expired question is not answerable", async () => {
    // Arrange
    harness.clock.advanceSeconds(15 * SECONDS_PER_DAY);

    // Act
    const answered = await answerAs(ken);

    // Assert
    expect(answered.status).toBe(400);
    expect((await failureOf(answered)).message).toContain("expired");
  });

  test("the answer's claim obeys the claim rules it would obey anywhere", async () => {
    // Arrange: likely_root_cause with no evidence is the rule every claim
    // path enforces — an answer must not be the way around it.
    const answered = await answerAs(ken, { status: "likely_root_cause" });

    // Assert
    expect(answered.status).toBe(400);
    expect((await failureOf(answered)).code).toBe("validation_failed");
  });
});

/**
 * MUTE, decided and pinned (spec: "decide, document and test mute semantics
 * explicitly"). A mute is reader-side and covers the reader's UNASKED
 * surfaces; it has never been a boundary. So:
 *
 *   the BRIEFING inbox is unasked      -> a muted asker's question is suppressed
 *   list_open_questions is a PULL      -> it still lists them
 *   an ANSWER to my own question       -> solicited, never suppressed
 *
 * And the asker learns nothing: they are not told, their question is simply
 * not answered, and `doctor` eventually tells THEM it expired.
 */
describe("mute and the question channel", () => {
  let harness: TestHarness;
  let nick: Party;
  let ken: Party;

  const mute = async (reader: Party, ref: string): Promise<void> => {
    const response = await harness.app.request(
      "/api/settings/mutes",
      jsonRequest("POST", reader.developer.apiKey, { developer: ref }),
    );
    expect(response.status).toBe(200);
  };

  const answerableFor = async (
    party: Party,
  ): Promise<readonly Record<string, unknown>[]> => {
    const response = await harness.app.request(
      `/api/questions?repo=${encodeURIComponent(REPO)}&answerable=1`,
      jsonRequest("GET", party.developer.apiKey),
    );
    const body = (await response.json()) as {
      data: { inbox: readonly Record<string, unknown>[] };
    };
    return body.data.inbox;
  };

  beforeEach(async () => {
    harness = await createTestHarness();
    nick = await seatDeveloper(harness, "Nick", "nick@example.com", "ses_nick");
    ken = await seatDeveloper(harness, "Ken", "ken@example.com", "ses_ken");
  });

  test("a muted asker's question leaves the briefing inbox but stays pullable", async () => {
    // Arrange: the CONTRAST first — unmuted, the question is in the inbox.
    const asked = await ask(harness, nick, {
      developer: "Ken",
      body: "Did the rate-limit variant of the importer ever get tried?",
    });
    expect(asked.status).toBe(200);
    expect((await readQuestions(harness, ken)).data.inbox).toHaveLength(1);

    // Act
    await mute(ken, "Nick");

    // Assert: gone from the unasked surface…
    expect((await readQuestions(harness, ken)).data.inbox).toHaveLength(0);
    // …and still there for the deliberate pull, like a muted teammate's tree.
    expect(await answerableFor(ken)).toHaveLength(1);
  });

  test("the asker is told nothing — a mute is never disclosed", async () => {
    // Arrange
    await mute(ken, "Nick");

    // Act
    const asked = await ask(harness, nick, {
      developer: "Ken",
      body: "Does the matcher retry on a 429 already?",
    });

    // Assert: the ask succeeds exactly as it would to an unmuted teammate.
    expect(asked.status).toBe(200);
    const body = (await asked.json()) as {
      data: { question: { id: string }; duplicate: boolean };
    };
    expect(body.data.duplicate).toBe(false);
    expect(body.data.question.id).toMatch(/^qn_/);
    const nicksView = await readQuestions(harness, nick);
    expect(nicksView.data.counts["asked"]).toBe(1);
  });

  test("an answer to my own question is solicited, so a mute never hides it", async () => {
    // Arrange: Nick mutes Ken, then asks Ken something anyway.
    const filed = await harness.app.request(
      "/api/records",
      jsonRequest("POST", ken.developer.apiKey, {
        records: [
          {
            cx: "0.1",
            id: "env_wc_ken",
            ts: harness.clock.now().toISOString(),
            producer: {
              developerId: ken.developer.developerId,
              agentKind: "claude-code",
              sessionId: ken.sessionId,
            },
            kind: "work_context",
            body: validWorkContextBody({
              id: "wc_ken",
              sessionId: ken.sessionId,
            }),
          },
        ],
      }),
    );
    expect(filed.status).toBe(200);
    await mute(nick, "Ken");
    const asked = await ask(harness, nick, {
      developer: "Ken",
      body: "Is the uploader backoff shared with the importer?",
    });
    const questionId = (
      (await asked.json()) as { data: { question: { id: string } } }
    ).data.question.id;

    // Act
    const answered = await harness.app.request(
      `/api/questions/${questionId}/answers`,
      jsonRequest("POST", ken.developer.apiKey, {
        claim: validClaimBody({
          id: "clm_answer",
          workContextId: "wc_ken",
          authorSessionId: ken.sessionId,
          body: "Yes — one shared token bucket.",
          createdAt: harness.clock.now().toISOString(),
        }),
      }),
    );

    // Assert
    expect(answered.status).toBe(200);
    const nicksView = await readQuestions(harness, nick);
    expect(nicksView.data.answers).toHaveLength(1);
  });
});

/**
 * Every refusal this channel can send is QUOTED by the connector at
 * MAX_HUB_MESSAGE_CHARS and the rest is dropped (mcp/tools/shared.ts), so a
 * sentence past the bound arrives with its actionable half missing — which is
 * exactly what happened to the search refusals in R1. Counted on the
 * NORMALIZED form, because that is the unit the reader's sanitizer counts in
 * (services/refusal.ts asRendered).
 */
describe("every question refusal fits what a connector quotes", () => {
  let harness: TestHarness;
  let nick: Party;
  let ken: Party;
  let mike: Party;

  const refusalsOf = async (): Promise<readonly string[]> => {
    const collected: string[] = [];
    const record = async (response: Response): Promise<void> => {
      collected.push((await failureOf(response)).message);
    };
    await record(await ask(harness, nick, { body: "no addressee at all?" }));
    await record(
      await ask(harness, nick, { developer: "   ", body: "blank name?" }),
    );
    await record(
      await ask(harness, nick, { developer: "Zzzz", body: "unknown name?" }),
    );
    await record(
      await ask(harness, nick, { developer: "Kim", body: "ambiguous name?" }),
    );
    await record(
      await ask(harness, nick, { developer: "Nick", body: "asking myself?" }),
    );
    await record(
      await ask(harness, nick, {
        workContextId: "wc_never_filed",
        body: "unknown context?",
      }),
    );
    // The three budget sentences: per target, then per author, then the answer
    // refusals — each driven through the real route, never transcribed.
    for (const topic of ["a", "b", "c", "d", "e"]) {
      await ask(harness, nick, {
        developer: topic < "d" ? "Ken" : "Mike",
        body: `Did you already try the retry path in the ${topic} importer?`,
      });
    }
    await record(
      await ask(harness, nick, { developer: "Ken", body: "one too many?" }),
    );
    await record(
      await ask(harness, nick, { developer: "Mike", body: "over the cap?" }),
    );
    await record(
      await harness.app.request(
        "/api/questions/qn_nobody_minted_this/answers",
        jsonRequest("POST", mike.developer.apiKey, {
          claim: validClaimBody({
            id: "clm_x",
            workContextId: WORK_CONTEXT_ID,
            authorSessionId: mike.sessionId,
            createdAt: harness.clock.now().toISOString(),
          }),
        }),
      ),
    );
    return collected;
  };

  beforeEach(async () => {
    harness = await createTestHarness();
    nick = await seatDeveloper(harness, "Nick", "nick@example.com", "ses_nick");
    ken = await seatDeveloper(harness, "Ken", "ken@example.com", "ses_ken");
    mike = await seatDeveloper(harness, "Mike", "mike@example.com", "ses_mike");
    await createTestDeveloper(harness, "Kim", "kim.a@example.com");
    await createTestDeveloper(harness, "Kim", "kim.b@example.com");
  });

  test("no refusal is longer than the 200 characters a connector keeps", async () => {
    // Act
    const refusals = await refusalsOf();

    // Assert: every one of them non-empty (a path that did not refuse would
    // silently pass this test) and every one inside the bound.
    expect(refusals.length).toBe(9);
    const tooLong = refusals
      .map((message) => ({ message, length: asRendered(message).length }))
      .filter((entry) => entry.length > MAX_REFUSAL_CHARS);
    expect(refusals.every((message) => message.length > 0)).toBe(true);
    expect(tooLong).toEqual([]);
  });
});
