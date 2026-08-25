/**
 * The asynchronous question channel end to end against a REAL hub (roadmap
 * R2): `ask_teammate` files a targeted, budgeted, expiring question;
 * `list_open_questions` is how the answering agent finds what was asked of
 * it; `answer_question` records a claim plus the `answers` edge and reaches
 * the person who asked. The refusals are proved on the real responses — a
 * secret-shaped question never reaches the hub, a third party is refused in
 * words that never quote the question, and a name nobody answers to comes
 * back naming the closest spelling instead of silence.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { createDb, createServer } from "@crosscheck/server";
import type { Db } from "@crosscheck/server";

import { QUOTED_DATA_NOTICE } from "../src/briefing/render.ts";
import { hintBodyHash } from "../src/hints/echo.ts";
import { prepareMcp } from "../src/mcp/context.ts";
import type { McpContext } from "../src/mcp/context.ts";
import { findTool } from "../src/mcp/tools/index.ts";
import {
  NO_ADDRESSEE_REFUSAL,
  QUESTION_SECRET_REFUSAL,
} from "../src/mcp/tools/ask-teammate.ts";
import { ANSWER_ECHO_REFUSAL } from "../src/mcp/tools/answer-question.ts";
import { NO_OPEN_QUESTIONS } from "../src/mcp/tools/list-open-questions.ts";
import { getQuestions } from "../src/http/hub.ts";
import {
  updateSessionState,
  writeSessionState,
} from "../src/state/session-state.ts";
import type { Env } from "../src/index.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const ADMIN_TOKEN = "questions-admin";
const REPO_ID = "github.com/acme/api";
const TITLE = "feat/importer @ api";
/** A synthetic AWS example key, the same fixture secret-scan.test.ts uses. */
const CREDENTIAL = "AKIAIOSFODNN7EXAMPLE";

let db: Db;
let server: ReturnType<typeof Bun.serve>;
let hubUrl: string;
const cleanups: string[] = [];

interface Developer {
  readonly developerId: string;
  readonly apiKey: string;
  readonly home: string;
  readonly repo: string;
  readonly env: Env;
  readonly hostSessionKey: string;
  readonly sessionId: string;
  readonly workContextId: string;
  readonly startedAt: string;
}

let nick: Developer;
let ken: Developer;
let mike: Developer;

const post = async (
  path: string,
  apiKey: string,
  body: unknown,
): Promise<Response> =>
  fetch(`${hubUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

const createDeveloper = async (
  name: string,
  email: string,
): Promise<{ developerId: string; apiKey: string }> => {
  const response = await post("/api/developers", ADMIN_TOKEN, { name, email });
  const body = (await response.json()) as {
    data: { developer: { id: string }; apiKey: string };
  };
  return { developerId: body.data.developer.id, apiKey: body.data.apiKey };
};

const setUpDeveloper = async (
  label: string,
  name: string,
  email: string,
): Promise<Developer> => {
  const account = await createDeveloper(name, email);
  const home = await makeHome(label);
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  cleanups.push(home, repo);
  const hostSessionKey = `${label}-uuid`;
  const sessionId = `cc_${hostSessionKey}`;
  const workContextId = `wc_${sessionId}`;
  const startedAt = new Date().toISOString();
  await post("/api/sessions", account.apiKey, {
    id: sessionId,
    agentKind: "claude-code",
    repo: REPO_ID,
    branch: "feat/importer",
    baseCommit: "a1b2c3d4",
    status: "analyzing",
  });
  await post("/api/records", account.apiKey, {
    records: [
      {
        cx: "0.1",
        id: `env_${crypto.randomUUID()}`,
        ts: startedAt,
        producer: {
          developerId: account.developerId,
          agentKind: "claude-code",
          sessionId,
        },
        kind: "work_context",
        body: {
          id: workContextId,
          sessionId,
          title: TITLE,
          status: "analyzing",
          createdAt: startedAt,
        },
      },
    ],
  });
  await writeSessionState(home, {
    hostSessionKey,
    crosscheckSessionId: sessionId,
    workContextId,
    repoId: REPO_ID,
    repoRoot: repo,
    hubUrl,
    developerId: account.developerId,
    startedAt,
    lastHeartbeatAt: startedAt,
    seenTargets: [],
    workContextTitle: TITLE,
    workContextStatus: "analyzing",
  });
  return {
    ...account,
    sessionId,
    workContextId,
    startedAt,
    home,
    repo,
    hostSessionKey,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hubUrl,
      CROSSCHECK_API_KEY: account.apiKey,
    },
  };
};

const contextFor = async (developer: Developer): Promise<McpContext> => {
  const setup = await prepareMcp(developer.env, developer.repo);
  if (!setup.ok) {
    throw new Error(`prepareMcp failed: ${setup.message}`);
  }
  return setup.ctx;
};

const call = async (
  developer: Developer,
  name: string,
  args: unknown,
): Promise<{ text: string; isError: boolean }> => {
  const tool = findTool(name);
  if (tool === undefined) {
    throw new Error(`no tool ${name}`);
  }
  const result = await tool.run(await contextFor(developer), args);
  return {
    text: result.content.map((part) => part.text).join("\n"),
    isError: result.isError === true,
  };
};

const inboxOf = async (
  developer: Developer,
): Promise<readonly Record<string, unknown>[]> => {
  const ctx = await contextFor(developer);
  const fetched = await getQuestions(ctx.hub, REPO_ID);
  if (!fetched.ok) {
    throw new Error("questions fetch failed");
  }
  return fetched.data.inbox as unknown as readonly Record<string, unknown>[];
};

const answersOf = async (
  developer: Developer,
): Promise<readonly Record<string, unknown>[]> => {
  const ctx = await contextFor(developer);
  const fetched = await getQuestions(ctx.hub, REPO_ID);
  if (!fetched.ok) {
    throw new Error("questions fetch failed");
  }
  return fetched.data.answers as unknown as readonly Record<string, unknown>[];
};

/**
 * The id out of the "Asked as qn_… " sentence — the caller's own next step.
 * The class deliberately EXCLUDES ":" even though an id may contain one: the
 * sentence is `Asked as <id>: «question»`, and a greedy class that allowed
 * the colon swallowed the sentence's own punctuation into the id.
 */
const askedId = (text: string): string =>
  /(?:Asked as|already have that question open as) (qn_[\w.-]+)/.exec(text)?.[1] ??
  "";

beforeAll(async () => {
  db = await createDb();
  server = Bun.serve({
    port: 0,
    fetch: createServer({ db, adminToken: ADMIN_TOKEN }).fetch,
  });
  hubUrl = `http://127.0.0.1:${String(server.port)}`;
  nick = await setUpDeveloper("qt-nick", "Nick", "nick-q@example.com");
  ken = await setUpDeveloper("qt-ken", "Ken Weber", "ken-q@example.com");
  mike = await setUpDeveloper("qt-mike", "Mike", "mike-q@example.com");
});

afterAll(async () => {
  server.stop(true);
  await Promise.all(
    cleanups.map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("ask_teammate", () => {
  test("files a targeted question and says what to expect, framed", async () => {
    // Act
    const result = await call(nick, "ask_teammate", {
      developer: "Ken Weber",
      question: "Did the rate-limit variant of the importer ever get tried?",
    });

    // Assert — the reply names the id and the next thing that happens
    expect(result.isError).toBe(false);
    expect(result.text).toContain(QUOTED_DATA_NOTICE);
    expect(result.text).toContain(
      "«Did the rate-limit variant of the importer ever get tried?»",
    );
    expect(askedId(result.text)).toMatch(/^qn_/);
    // — and it really reached Ken, and only Ken
    const kensInbox = await inboxOf(ken);
    expect(kensInbox.map((question) => question["body"])).toContain(
      "Did the rate-limit variant of the importer ever get tried?",
    );
    expect(await inboxOf(mike)).toHaveLength(0);
  });

  test("the same question again is a duplicate naming the id already open", async () => {
    // Arrange
    const first = await call(nick, "ask_teammate", {
      developer: "Ken Weber",
      question: "Does the matcher retry on a 429 already?",
    });
    const firstId = askedId(first.text);

    // Act
    const second = await call(nick, "ask_teammate", {
      developer: "Ken Weber",
      question: "  Does the MATCHER retry on a 429   already? ",
    });

    // Assert
    expect(second.isError).toBe(false);
    expect(second.text).toContain("You already have that question open");
    expect(askedId(second.text)).toBe(firstId);
  });

  test("a question with no addressee is refused, and nothing is sent", async () => {
    // Arrange
    const before = (await inboxOf(ken)).length;

    // Act
    const result = await call(nick, "ask_teammate", {
      question: "Has anybody looked at the importer?",
    });

    // Assert
    expect(result.isError).toBe(true);
    expect(result.text).toBe(NO_ADDRESSEE_REFUSAL);
    expect(await inboxOf(ken)).toHaveLength(before);
  });

  test("a credential-shaped question is dropped before the hub sees it", async () => {
    // Arrange
    const before = (await inboxOf(ken)).length;

    // Act
    const result = await call(nick, "ask_teammate", {
      developer: "Ken Weber",
      question: `Is the importer still using ${CREDENTIAL} for the S3 leg?`,
    });

    // Assert — refused, the match never echoed back, and nothing uploaded
    expect(result.isError).toBe(true);
    expect(result.text).toBe(QUESTION_SECRET_REFUSAL);
    expect(result.text).not.toContain(CREDENTIAL);
    expect(await inboxOf(ken)).toHaveLength(before);
  });

  test("a name nobody answers to comes back naming the closest spelling", async () => {
    // Act
    const result = await call(nick, "ask_teammate", {
      developer: "Kenn Webber",
      question: "Did you finish the importer retry path?",
    });

    // Assert: never silence, never an empty success — R1's rule, this channel.
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Ken Weber");
  });
});

describe("list_open_questions", () => {
  test("shows what was asked of me, with the id that answers it", async () => {
    // Act
    const result = await call(ken, "list_open_questions", {});

    // Assert
    expect(result.isError).toBe(false);
    expect(result.text).toContain(QUOTED_DATA_NOTICE);
    expect(result.text).toContain("waiting for an answer from you");
    expect(result.text).toContain("answer_question qn_");
    expect(result.text).toContain(
      "«Did the rate-limit variant of the importer ever get tried?»",
    );
  });

  test("says so out loud when nobody is waiting", async () => {
    // Act: Mike was never asked anything.
    const result = await call(mike, "list_open_questions", {});

    // Assert
    expect(result.isError).toBe(false);
    expect(result.text).toBe(NO_OPEN_QUESTIONS);
  });
});

describe("answer_question", () => {
  let questionId: string;

  beforeAll(async () => {
    const asked = await call(nick, "ask_teammate", {
      developer: "Ken Weber",
      question: "Is the uploader's backoff shared with the importer?",
    });
    questionId = askedId(asked.text);
  });

  test("a third party is refused in words that never quote the question", async () => {
    // Act
    const result = await call(mike, "answer_question", {
      questionId,
      body: "I think so, but I have not checked.",
    });

    // Assert
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain("uploader");
    expect(result.text).not.toContain("backoff");
    expect(await answersOf(nick)).toHaveLength(0);
  });

  test("the named teammate answers and it reaches the asker", async () => {
    // Act
    const result = await call(ken, "answer_question", {
      questionId,
      body: "Yes — both share one token bucket, so the uploader starves it.",
      kind: "observation",
    });

    // Assert — the reply
    expect(result.isError).toBe(false);
    expect(result.text).toContain(QUOTED_DATA_NOTICE);
    expect(result.text).toContain(`Answered ${questionId}`);
    // — the asker's side
    const answers = await answersOf(nick);
    const answer = answers.find((row) => row["questionId"] === questionId);
    expect(answer?.["claimBody"]).toBe(
      "Yes — both share one token bucket, so the uploader starves it.",
    );
    expect(answer?.["answererDeveloperName"]).toBe("Ken Weber");
    expect(answer?.["provenance"]).toBe("declared");
    // — and the claim landed on the ANSWERER's own context, not the asker's
    const tree = await fetch(
      `${hubUrl}/api/work-contexts/${ken.workContextId}/diagnosis`,
      { headers: { Authorization: `Bearer ${ken.apiKey}` } },
    );
    const body = (await tree.json()) as {
      data: { claims: { body: string }[] };
    };
    expect(body.data.claims.map((claim) => claim.body)).toContain(
      "Yes — both share one token bucket, so the uploader starves it.",
    );
  });

  test("answering with a teammate's delivered hint is refused as an echo", async () => {
    // Arrange: a hint really was delivered to Ken this session.
    const borrowed = "The token bucket is shared and the uploader starves it.";
    await updateSessionState(ken.home, ken.hostSessionKey, (fresh) => ({
      ...fresh,
      deliveredHintHashes: [
        ...(fresh.deliveredHintHashes ?? []),
        hintBodyHash(borrowed),
      ],
    }));
    const asked = await call(nick, "ask_teammate", {
      developer: "Ken Weber",
      question: "Where does the uploader's throughput go at 40 rps?",
    });

    // Act
    const result = await call(ken, "answer_question", {
      questionId: askedId(asked.text),
      body: borrowed,
    });

    // Assert
    expect(result.isError).toBe(true);
    expect(result.text).toBe(ANSWER_ECHO_REFUSAL);
  });
});
