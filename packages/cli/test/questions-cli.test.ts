/**
 * The question channel's OBSERVABILITY (roadmap R2): `crosscheck status`
 * prints the backlog in both directions, and `doctor` WARNs on the two ways
 * this channel actually fails — a teammate who has been waiting on you past
 * half a question's life, and a question you asked that expired with nobody
 * told. Never a PASS-only counter (the finding-#14 lesson).
 *
 * Driven against a real hub over PGlite, through `runCli`, so the sentences
 * are the ones a human sees rather than the ones a formatter returns.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { eq } from "drizzle-orm";

import { createDb, createServer } from "@crosscheck/server";
import type { Db } from "@crosscheck/server";
// Relative, because the server package exports only its barrel: the test
// needs the TABLE to backdate a row, which is the one thing a client cannot
// do — the hub owns created_at and expires_at on purpose.
import { questions } from "../../server/src/db/schema.ts";

import { runCli } from "../src/index.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const ADMIN_TOKEN = "questions-cli-admin";
const REPO_ID = "github.com/acme/api";
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const TTL_DAYS = 14;

let db: Db;
let server: ReturnType<typeof Bun.serve>;
let hubUrl: string;
let home: string;
let repo: string;
let readerKey: string;
let nickKey: string;

const createDeveloper = async (
  name: string,
  email: string,
): Promise<{ readonly apiKey: string; readonly id: string }> => {
  const response = await fetch(`${hubUrl}/api/developers`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, email }),
  });
  const body = (await response.json()) as {
    data: { apiKey: string; developer: { id: string } };
  };
  return { apiKey: body.data.apiKey, id: body.data.developer.id };
};

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

const runFor = (
  apiKey: string,
  argv: readonly string[],
): Promise<{ stdout: string; exitCode: number }> =>
  runCli(
    [...argv],
    {
      CROSSCHECK_HOME: home,
      HOME: home,
      CROSSCHECK_HUB_URL: hubUrl,
      CROSSCHECK_API_KEY: apiKey,
      CROSSCHECK_TIMEOUT_MS: "4000",
      // The doctor's model probe costs seconds and says nothing about this.
      CROSSCHECK_DOCTOR_NO_PROBE: "1",
    },
    repo,
  );

/**
 * Backdates a stored question, which is the only way to reach the doctor's
 * thresholds without waiting a week. Done in the DATABASE rather than on the
 * wire, because the hub owns `created_at` and `expires_at` precisely so a
 * client cannot do this.
 */
const backdate = async (id: string, days: number): Promise<void> => {
  const createdAt = new Date(Date.now() - days * MS_PER_DAY);
  await db
    .update(questions)
    .set({
      createdAt,
      expiresAt: new Date(createdAt.getTime() + TTL_DAYS * MS_PER_DAY),
    })
    .where(eq(questions.id, id));
};

const ask = async (
  apiKey: string,
  sessionId: string,
  body: string,
  developer: string,
): Promise<string> => {
  const id = `qn_${crypto.randomUUID()}`;
  const response = await post("/api/questions", apiKey, {
    id,
    repo: REPO_ID,
    sessionId,
    body,
    developer,
  });
  if (response.status !== 200) {
    throw new Error(`ask failed: ${String(response.status)}`);
  }
  return id;
};

/**
 * The doctor's OWN "questions" check line, matched on the check NAME rather
 * than on the substring: the temp home directory is called cx-home-qcli-…
 * and an earlier version of this helper happily matched the "config present"
 * line because the PATH in it contained the word.
 */
const questionLineOf = (stdout: string): string =>
  stdout.split("\n").find((line) => /\b(?:PASS|WARN|FAIL) +questions /.test(line)) ??
  "";

beforeAll(async () => {
  db = await createDb();
  server = Bun.serve({
    port: 0,
    fetch: createServer({ db, adminToken: ADMIN_TOKEN }).fetch,
  });
  hubUrl = `http://127.0.0.1:${String(server.port)}`;
  home = await makeHome("qcli");
  repo = await makeRepo("qcli", {
    remote: "git@github.com:acme/api.git",
  });
  readerKey = (await createDeveloper("Reader", "reader-q@example.com")).apiKey;
  nickKey = (await createDeveloper("Nick", "nick-qcli@example.com")).apiKey;
  for (const [key, id] of [
    [readerKey, "cc_reader"],
    [nickKey, "cc_nick"],
  ] as const) {
    await post("/api/sessions", key, {
      id,
      agentKind: "claude-code",
      repo: REPO_ID,
      branch: "feat/importer",
      baseCommit: "a1b2c3d4",
      status: "analyzing",
    });
  }
});

afterAll(async () => {
  server.stop(true);
  await Promise.all(
    [home, repo].map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("crosscheck status", () => {
  test("prints the backlog in both directions, with the oldest age", async () => {
    // Arrange: the CONTRAST first — an empty channel still gets a line, so a
    // reader can tell "nothing waiting" from "this hub cannot say".
    const empty = await runFor(readerKey, ["status"]);
    expect(empty.stdout).toContain("questions: none open to you · none asked");

    // Act: Nick asks the reader something, three days ago.
    const asked = await ask(
      nickKey,
      "cc_nick",
      "Did the rate-limit variant of the importer ever get tried?",
      "Reader",
    );
    await backdate(asked, 3);
    const result = await runFor(readerKey, ["status"]);

    // Assert
    expect(result.stdout).toContain("questions: 1 open to you (oldest 3d)");
    const askerSide = await runFor(nickKey, ["status"]);
    expect(askerSide.stdout).toContain("1 asked (0 answered)");
  });
});

describe("crosscheck doctor", () => {
  test("PASSES a fresh channel and WARNS once a teammate has waited past the threshold", async () => {
    // Arrange: the CONTRAST — a question asked today is not a problem.
    const fresh = await ask(
      nickKey,
      "cc_nick",
      "Is the uploader backoff shared with the importer?",
      "Reader",
    );
    expect(questionLineOf((await runFor(readerKey, ["doctor"])).stdout)).toContain(
      "PASS",
    );

    // Act: the same question, eight days old — past half its 14-day life.
    await backdate(fresh, 8);
    const after = await runFor(readerKey, ["doctor"]);

    // Assert
    const warned = questionLineOf(after.stdout);
    expect(warned).toContain("WARN");
    expect(warned).toContain("waiting");
    expect(warned).toContain("list_open_questions");
  });

  test("WARNS the ASKER about their own questions that expired unanswered", async () => {
    // Arrange: a question of Nick's, older than the whole TTL.
    const stale = await ask(
      nickKey,
      "cc_nick",
      "Does the matcher retry on a 429 already?",
      "Reader",
    );
    await backdate(stale, 20);

    // Act
    const result = await runFor(nickKey, ["doctor"]);

    // Assert: the asker is told nobody was told — nothing retries, and
    // silence here is the one failure this channel is built to make visible.
    const line = questionLineOf(result.stdout);
    expect(line).toContain("WARN");
    expect(line).toContain("expired unanswered");
  });
});
