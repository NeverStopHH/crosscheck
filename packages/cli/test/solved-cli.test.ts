/**
 * The solved-pointer precision loop's OBSERVABILITY (VISION.md §1):
 * `crosscheck status` prints what the "solved before" lines earned, and
 * `doctor` WARNs when they are shown and never opened — which is what this
 * surface looks like when its matches are wrong. Never a PASS-only counter
 * (the finding-#14 lesson).
 *
 * Driven against a real hub over PGlite, through `runCli`, so the sentences
 * asserted are the ones a human reads rather than the ones a formatter
 * returns.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { createDb, createServer } from "@crosscheck/server";
import type { Db } from "@crosscheck/server";

import { runCli } from "../src/index.ts";
import { DOCTOR_SOLVED_SHOWN_WARN } from "@crosscheck/connector-core/constants.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const ADMIN_TOKEN = "solved-cli-admin";
const REPO_ID = "github.com/acme/api";
const SESSION_ID = "cc_reader";

let db: Db;
let server: ReturnType<typeof Bun.serve>;
let hubUrl: string;
let home: string;
let repo: string;
let readerKey: string;
let readerId: string;

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
  argv: readonly string[],
): Promise<{ stdout: string; exitCode: number }> =>
  runCli(
    [...argv],
    {
      CROSSCHECK_HOME: home,
      HOME: home,
      CROSSCHECK_HUB_URL: hubUrl,
      CROSSCHECK_API_KEY: readerKey,
      CROSSCHECK_TIMEOUT_MS: "4000",
      // The doctor's model probe costs seconds and says nothing about this.
      CROSSCHECK_DOCTOR_NO_PROBE: "1",
    },
    repo,
  );

const envelope = (kind: string, body: unknown): Record<string, unknown> => ({
  cx: "0.1",
  id: `env_${crypto.randomUUID()}`,
  ts: new Date().toISOString(),
  producer: {
    developerId: readerId,
    agentKind: "claude-code",
    sessionId: SESSION_ID,
  },
  kind,
  body,
});

/** A solved tree: an evidenced, declared, standing root cause. */
const seedSolvedTree = async (contextId: string): Promise<void> => {
  const now = new Date().toISOString();
  const response = await post("/api/records", readerKey, {
    records: [
      envelope("work_context", {
        id: contextId,
        sessionId: SESSION_ID,
        title: "Refresh 500s after key rotation",
        status: "analyzing",
        createdAt: now,
      }),
      envelope("claim", {
        id: `${contextId}_evidence`,
        workContextId: contextId,
        authorSessionId: SESSION_ID,
        kind: "evidence",
        body: "The trace shows the rotated key id being dropped",
        status: "proposed",
        confidence: 0.8,
        captureMode: "agent",
        provenance: "declared",
        evidenceRefs: [],
        createdAt: now,
      }),
      envelope("claim", {
        id: `${contextId}_root`,
        workContextId: contextId,
        authorSessionId: SESSION_ID,
        kind: "root_cause",
        body: "The ingestion mapping drops the key id on rotation",
        status: "likely_root_cause",
        confidence: 0.9,
        captureMode: "agent",
        provenance: "declared",
        evidenceRefs: [`${contextId}_evidence`],
        createdAt: now,
      }),
    ],
  });
  if (response.status !== 200) {
    throw new Error(`seeding the tree failed: ${String(response.status)}`);
  }
};

const deliverPointer = async (contextId: string): Promise<void> => {
  const response = await post("/api/records", readerKey, {
    records: [
      envelope("hint_delivery", {
        id: `hd_${crypto.randomUUID().replace(/-/g, "")}`,
        sessionId: SESSION_ID,
        refKind: "work_context",
        refId: contextId,
        deliveredAt: new Date().toISOString(),
      }),
    ],
  });
  if (response.status !== 200) {
    throw new Error(`delivery failed: ${String(response.status)}`);
  }
};

/**
 * The doctor's OWN "solved-tree pointers" line, matched on the check NAME
 * rather than on a substring — the temp home is called cx-home-solved-cli-…
 * and a substring match would happily find the "config present" path line.
 */
const solvedLineOf = (stdout: string): string =>
  stdout
    .split("\n")
    .find((line) => /\b(?:PASS|WARN|FAIL) +solved-tree pointers /.test(line)) ??
  "";

beforeAll(async () => {
  db = await createDb();
  server = Bun.serve({
    port: 0,
    fetch: createServer({ db, adminToken: ADMIN_TOKEN }).fetch,
  });
  hubUrl = `http://127.0.0.1:${String(server.port)}`;
  home = await makeHome("solved-cli");
  repo = await makeRepo("solved-cli", { remote: "git@github.com:acme/api.git" });
  const reader = await createDeveloper("Reader", "reader-solved@example.com");
  readerKey = reader.apiKey;
  readerId = reader.id;
  await post("/api/sessions", readerKey, {
    id: SESSION_ID,
    agentKind: "claude-code",
    repo: REPO_ID,
    branch: "feat/importer",
    baseCommit: "a1b2c3d4",
    status: "analyzing",
  });
});

afterAll(async () => {
  server.stop(true);
  await Promise.all(
    [home, repo].map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("the solved-match precision loop on status and doctor", () => {
  test("an untouched hub says so instead of scoring zero", async () => {
    // Arrange / Act: the CONTRAST first — nothing shown is not a bad score,
    // and a line reading "0 pulled" would invite exactly that reading.
    const status = await runFor(["status"]);
    const doctor = await runFor(["doctor"]);

    // Assert
    expect(status.stdout).toContain("solved-tree pointers: not measured yet");
    expect(solvedLineOf(doctor.stdout)).toContain("PASS");
    expect(solvedLineOf(doctor.stdout)).toContain("not measured yet");
  });

  test("pointers shown and never opened turn the doctor line into a WARN", async () => {
    // Arrange: exactly the evidence floor — the point at which "shown and
    // ignored" stops being one busy afternoon and starts being the surface.
    for (let index = 0; index < DOCTOR_SOLVED_SHOWN_WARN; index += 1) {
      const contextId = `wc_solved_${String(index)}`;
      await seedSolvedTree(contextId);
      await deliverPointer(contextId);
    }

    // Act
    const status = await runFor(["status"]);
    const doctor = await runFor(["doctor"]);

    // Assert: status states the pair plainly; doctor names the problem and
    // what it means — never a bare number.
    expect(status.stdout).toContain(
      `solved-tree pointers: ${String(DOCTOR_SOLVED_SHOWN_WARN)} shown, 0 opened in the last`,
    );
    const line = solvedLineOf(doctor.stdout);
    expect(line).toContain("WARN");
    expect(line).toContain("shown and");
    expect(line).toContain("ignored");
    // A WARN that diagnoses the product to the reader and stops there gets
    // skipped, which makes the counter PASS-only in practice — the exact
    // failure it was added to prevent. So it ends with the call, the way
    // questionWarning does one block over.
    expect(line).toContain("get_diagnosis <id>");
  });

  test("opening one tree clears the warning and the count follows", async () => {
    // Act: the reader pulls one — the same GET `get_diagnosis` makes.
    const read = await fetch(
      `${hubUrl}/api/work-contexts/wc_solved_0/diagnosis`,
      { headers: { Authorization: `Bearer ${readerKey}` } },
    );
    expect(read.status).toBe(200);
    const status = await runFor(["status"]);
    const doctor = await runFor(["doctor"]);

    // Assert
    expect(status.stdout).toContain(
      `solved-tree pointers: ${String(DOCTOR_SOLVED_SHOWN_WARN)} shown, 1 opened in the last`,
    );
    expect(solvedLineOf(doctor.stdout)).toContain("PASS");
  });
});
