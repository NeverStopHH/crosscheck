/**
 * THE TWO FAILURES ONLY THE HUB CAN SEE.
 *
 * `epoch_conflict` and `epoch_split` are computed on the hub, stored on every
 * row, and were printed nowhere. Doctor's `event sequence` line reads LOCAL
 * state files, which can see a session with no epoch and a worktree with two
 * live sessions — and structurally cannot see either of these, because both
 * are facts about rows the hub holds and the connector never reads back.
 *
 * So a session whose ENTIRE causal order is broken — every happens-before
 * question about it refused, `explanation_timing` uncomputable for the whole
 * session — looked exactly like a healthy one on the only surface that
 * describes this machine. Non-negotiable #4: every error path is visible in
 * status or doctor.
 *
 * NO POLL AND NO JOB — but it IS one more read, and saying otherwise would be
 * the kind of quiet claim this file exists to catch. The obvious fold was onto
 * the rows `GET /api/sessions?open=1&mine=1` already returns, and it cannot be
 * done: that listing is deliberately scoped to sessions that have STOPPED
 * reporting past the reaper's window, so a line riding on it would go silent
 * for hours after a split and speak only once the session was already gone.
 * `GET /api/sessions/order` is read-only, runs when a human types `crosscheck
 * doctor`, and 404s on an older hub — which reads as "not measured", never as
 * "none broken".
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { createDb, createServer } from "@crosscheck/server";
import {
  deriveSessionState,
  writeSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";

import { runCli } from "../src/index.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const ADMIN_TOKEN = "seq-doctor-hub-admin";
const REPO_ID = "github.com/acme/api";
const EPOCH = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const OTHER_EPOCH = "11111111-2222-4333-8444-555555555555";
const SESSION = "cc_split";

interface Account {
  readonly apiKey: string;
  readonly developerId: string;
}

let server: ReturnType<typeof Bun.serve>;
let hubUrl: string;
const paths: string[] = [];

const post = async (
  path: string,
  key: string,
  body: unknown,
): Promise<Response> =>
  fetch(`${hubUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  const db = await createDb();
  server = Bun.serve({
    port: 0,
    fetch: createServer({ db, adminToken: ADMIN_TOKEN }).fetch,
  });
  hubUrl = `http://127.0.0.1:${String(server.port)}`;
});

/**
 * ONE DEVELOPER PER TEST. The order listing is scoped to the caller's own
 * sessions, so a shared account would let the broken session of one case
 * answer the "nothing broken" assertion of the next.
 */
const newAccount = async (label: string): Promise<Account> => {
  const response = await fetch(`${hubUrl}/api/developers`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: label, email: `${label}@example.com` }),
  });
  const account = (
    (await response.json()) as {
      data: { developer: { id: string }; apiKey: string };
    }
  ).data;
  return { apiKey: account.apiKey, developerId: account.developer.id };
};

afterAll(async () => {
  server.stop(true);
  await Promise.all(
    paths.map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** One open session on the hub, with a work context its targets can hang on. */
const registerSession = async (
  account: Account,
  id: string,
): Promise<void> => {
  const { apiKey, developerId } = account;
  await post("/api/sessions", apiKey, {
    id,
    agentKind: "claude-code",
    repo: REPO_ID,
    branch: "main",
    baseCommit: "a1b2c3d4",
    status: "analyzing",
  });
  await post("/api/records", apiKey, {
    records: [
      {
        cx: "0.1",
        id: `env_${crypto.randomUUID()}`,
        ts: new Date().toISOString(),
        producer: { developerId, agentKind: "claude-code", sessionId: id },
        kind: "work_context",
        body: {
          id: `wc_${id}`,
          sessionId: id,
          title: "Login 500s on staging",
          status: "analyzing",
          createdAt: new Date().toISOString(),
        },
      },
    ],
  });
};

/** A `target` record, which the hub projects as `file.modified`. */
const edit = async (
  account: Account,
  sessionId: string,
  value: string,
  epoch: string,
  n: number,
): Promise<void> => {
  const { apiKey, developerId } = account;
  await post("/api/records", apiKey, {
    records: [
      {
        cx: "0.1",
        id: `env_${crypto.randomUUID()}`,
        ts: new Date().toISOString(),
        producer: { developerId, agentKind: "claude-code", sessionId },
        kind: "target",
        body: {
          workContextId: `wc_${sessionId}`,
          kind: "file",
          value,
          source: "tool_edit",
        },
        seq: { epoch, n },
      },
    ],
  });
};

/** One healthy local state file, so nothing LOCAL has anything to warn about. */
const seedLocal = async (
  account: Account,
  home: string,
  repo: string,
): Promise<void> => {
  await writeSessionState(home, {
    ...deriveSessionState({
      hostSessionKey: "local-uuid",
      repoId: REPO_ID,
      repoRoot: repo,
      hubUrl,
      developerId: account.developerId,
      startedAt: new Date().toISOString(),
    }),
    lastHeartbeatAt: new Date().toISOString(),
    seqEpoch: EPOCH,
    eventSeq: 9,
  });
};

const doctorOutput = async (
  account: Account,
  home: string,
  repo: string,
): Promise<string> => {
  const result = await runCli(
    ["doctor"],
    {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hubUrl,
      CROSSCHECK_API_KEY: account.apiKey,
      CROSSCHECK_SSH_CANONICALIZE: "off",
    },
    repo,
  );
  return result.stdout;
};

describe("doctor prints the order failures only the hub can see", () => {
  test("a session holding two epochs WARNs, and the line says what it costs", async () => {
    // Arrange: one session, two counters — a second home on one host session
    // key, or a state file re-created without carrying the epoch. Every
    // cross-epoch comparison in this session is refused from here on.
    const home = await makeHome("seq-doctor-hub-split");
    const repo = await makeRepo("seq-doctor-hub-split", {
      remote: "git@github.com:acme/api.git",
    });
    paths.push(home, repo);
    const account = await newAccount("splitowner");
    await seedLocal(account, home, repo);
    await registerSession(account, SESSION);
    await edit(account, SESSION, "src/auth/refresh.ts", EPOCH, 1);
    await edit(account, SESSION, "src/auth/token.ts", OTHER_EPOCH, 1);

    // Act
    const output = await doctorOutput(account, home, repo);

    // Assert: the count, the state, and the consequence — never a bare number.
    expect(output).toContain("WARN  event sequence");
    expect(output).toContain("1 session on the hub");
    expect(output).toContain("epoch_split");
    expect(output).toContain("cannot be ordered");
  });

  test("a healthy hub session adds no warning of its own", async () => {
    // Arrange: the same shape with ONE epoch, so the assertion above is about
    // the split and not about any session existing on the hub at all.
    const home = await makeHome("seq-doctor-hub-ok");
    const repo = await makeRepo("seq-doctor-hub-ok", {
      remote: "git@github.com:acme/api.git",
    });
    paths.push(home, repo);
    const account = await newAccount("wholeowner");
    await seedLocal(account, home, repo);
    await registerSession(account, "cc_whole");
    await edit(account, "cc_whole", "src/auth/refresh.ts", EPOCH, 1);
    await edit(account, "cc_whole", "src/auth/token.ts", EPOCH, 2);

    // Act
    const output = await doctorOutput(account, home, repo);

    // Assert
    expect(output).toContain("event sequence");
    expect(output).not.toContain("epoch_split");
  });
});
