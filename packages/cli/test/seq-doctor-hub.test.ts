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

/**
 * `doctor` against a hub that answers ONLY the order route, with the body
 * given — for the states a real hub in this test cannot be put in cheaply.
 */
const fakeHubDoctor = async (body: unknown): Promise<string> => {
  const fake = Bun.serve({
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname === "/api/sessions/order"
        ? Response.json({ ok: true, data: body })
        : Response.json(
            { ok: false, error: { code: "not_found", message: "not here" } },
            { status: 404 },
          ),
  });
  const home = await makeHome("seq-doctor-hub-fake");
  const repo = await makeRepo("seq-doctor-hub-fake", {
    remote: "git@github.com:acme/api.git",
  });
  paths.push(home, repo);
  try {
    const result = await runCli(
      ["doctor"],
      {
        CROSSCHECK_HOME: home,
        CROSSCHECK_HUB_URL: `http://127.0.0.1:${String(fake.port)}`,
        CROSSCHECK_API_KEY: "k",
        CROSSCHECK_SSH_CANONICALIZE: "off",
      },
      repo,
    );
    return result.stdout;
  } finally {
    fake.stop(true);
  }
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

  test("the hub declares its sweep, and doctor says what it removes and what it keeps", async () => {
    // Arrange: 01a turned retention back on, in the interim mode. An operator
    // has to be able to read the decision, and the only one who can state it
    // is the hub itself: one hub serves connectors of several versions, so a
    // sentence compiled into this CLI would describe whatever hub the CLI was
    // built beside.
    const home = await makeHome("seq-doctor-hub-retention");
    const repo = await makeRepo("seq-doctor-hub-retention", {
      remote: "git@github.com:acme/api.git",
    });
    paths.push(home, repo);
    const account = await newAccount("retentionowner");
    await seedLocal(account, home, repo);

    // Act
    const output = await doctorOutput(account, home, repo);

    // Assert: PASS — a decision, not a defect — the whole sentence, and what
    // it is keeping, from the hub's own report.
    expect(output).toContain(
      "PASS  session-event retention  interim — a session's events go, all of them together, only once it ended on its own more than 30 days ago, nothing still depends on its order, and it touched no file; every session that touched a file is kept, until a person switches this hub to full",
    );
    // Nothing is claimed about a cycle that has not run: this hub's timer is
    // not started in a test, and SessionStart passes never sweep
    expect(output).toContain(
      "PASS  skeleton retention  the sweep has not finished a cycle over this hub's sessions since the hub started (no pass has run yet)",
    );
  });

  test("a hub that retires nothing says so, in a sentence that says what is kept", async () => {
    // Arrange — `off` stays a mode a hub may declare.
    //
    // IT HAS TO SAY WHAT IS KEPT. The sentence used to read "off — the
    // age-based sweep is withdrawn; spec 01a's referential predicate replaces
    // it", which never said the rows are kept, never said nothing deletes
    // them, and put a mechanism that does not exist in this tree
    // (`pruneSessionEvents` is called from nowhere and no referential sweep is
    // implemented) in the PRESENT tense. A reader took "replaces it" as "a
    // different mechanism is handling retention", which is the opposite of the
    // fact — the surprise this line's own header claims it prevents, on the
    // one axis where being wrong is expensive: a per-developer, per-second
    // activity trail nothing removes. Measured: 501 rows from one 500-edit
    // session, 327,680 bytes of relation, and `reapStaleSessions` over rows
    // backdated 900 days removed none of them.
    const output = await fakeHubDoctor({ sessions: [], retention: "off" });

    // Assert
    expect(output).toContain(
      "PASS  session-event retention  off — nothing deletes session events: every row is kept and the table grows without bound, by decision. The age-based sweep was withdrawn; spec 01a's referential predicate is meant to replace it and is not running here",
    );
  });

  test("the mode sentence carries the hub's own window, and no number without one", async () => {
    // Act — a hub that keeps sessions 45 days, and one that sent no report
    const withReport = await fakeHubDoctor({
      sessions: [],
      retention: "full",
      skeleton: {
        windowDays: 45,
        heldBy: [],
        completedAt: null,
        lastPassAt: null,
        aged: 0,
        swept: 0,
        unresolvedPinIds: [],
        keptBy: [],
        unresolved: 0,
        fileBearing: 0,
        reapedAwaitingEnd: 0,
        unresolvedPins: 0,
        sweepFailures: 0,
      },
    });
    const withoutReport = await fakeHubDoctor({ sessions: [], retention: "full" });

    // Assert
    expect(withReport).toContain("only once it ended on its own more than 45 days ago");
    expect(withoutReport).toContain("only once it ended on its own longer ago than the hub's retention window");
    expect(withoutReport).toContain("PASS  skeleton retention  not measured");
  });

  test.each([
    [
      "what each reason keeps, with the spec that owes a root its rule",
      "interim",
      {
        windowDays: 30,
        heldBy: [],
        completedAt: "2026-09-24T06:00:00.000Z",
        lastPassAt: "2026-09-24T06:15:00.000Z",
        aged: 7,
        swept: 2,
        keptBy: [
          { root: "claims", sessions: 3 },
          { root: "pins", sessions: 1 },
          { root: "intent_versions", sessions: 0 },
        ],
        unresolved: 1,
        fileBearing: 2,
        reapedAwaitingEnd: 1,
        unresolvedPins: 1,
        unresolvedPinIds: ["pin_lost"],
        sweepFailures: 0,
      },
      "PASS  skeleton retention  last full cycle 2026-09-24T06:00:00.000Z: 7 explicitly ended sessions past the window held a skeleton and 2 were retired; reached by claims 3 (liveness owed by 02/04), pinned files 1; 1 kept because a file identity could not be resolved; 2 touched files, which this mode keeps whatever reaches them; a session counts under every reason that keeps it; 1 reaped session past the window is never retired while the end is only inferred from silence; 1 pin on this hub cannot be tied to its files (pin_lost), and each keeps every file-bearing session of its repo: `crosscheck pin --sweep` clears a pin whose file is only missing, and nothing in 1.0 clears one whose history lost a name",
    ],
    [
      "the same cycle in full mode, which keeps no file-bearing session for touching a file",
      "full",
      {
        windowDays: 30,
        heldBy: [],
        completedAt: "2026-09-24T06:00:00.000Z",
        lastPassAt: "2026-09-24T06:15:00.000Z",
        aged: 3,
        swept: 1,
        keptBy: [{ root: "claims", sessions: 2 }],
        unresolved: 0,
        fileBearing: 2,
        reapedAwaitingEnd: 0,
        unresolvedPins: 0,
        unresolvedPinIds: [],
        sweepFailures: 0,
      },
      "PASS  skeleton retention  last full cycle 2026-09-24T06:00:00.000Z: 3 explicitly ended sessions past the window held a skeleton and 1 was retired; reached by claims 2 (liveness owed by 02/04); a session counts under every reason that keeps it",
    ],
    [
      "a sweep held by a root nobody built",
      "interim",
      {
        windowDays: 30,
        heldBy: ["pilot_sessions"],
        completedAt: null,
        lastPassAt: "2026-09-24T06:15:00.000Z",
        aged: 0,
        swept: 0,
        keptBy: [],
        unresolved: 0,
        fileBearing: 0,
        reapedAwaitingEnd: 0,
        unresolvedPins: 0,
        unresolvedPinIds: [],
        sweepFailures: 0,
      },
      "WARN  skeleton retention  the sweep is held and deletes nothing: pilot session records is declared as a retention root and not built yet",
    ],
    [
      "a sweep that failed before completing a cycle",
      "interim",
      {
        windowDays: 30,
        heldBy: [],
        completedAt: null,
        lastPassAt: "2026-09-24T06:15:00.000Z",
        aged: 0,
        swept: 0,
        keptBy: [],
        unresolved: 0,
        fileBearing: 0,
        reapedAwaitingEnd: 0,
        unresolvedPins: 0,
        unresolvedPinIds: [],
        sweepFailures: 2,
      },
      "WARN  skeleton retention  2 sweep passes failed since the hub started, and a failed pass deletes nothing; the sweep has not finished a cycle over this hub's sessions since the hub started (last pass 2026-09-24T06:15:00.000Z)",
    ],
    [
      "a newer hub's report that says its sweep is held",
      "interim",
      { heldBy: ["a_root_from_2099"], aged: 1 },
      "WARN  skeleton retention  the hub reports what it keeps in a form this crosscheck cannot read — upgrade the CLI to see it; it does say its sweep is held or has failed",
    ],
    [
      "a newer hub's report with nothing to warn about",
      "interim",
      { heldBy: [], aged: 1, a_field_from_2099: true },
      "PASS  skeleton retention  the hub reports what it keeps in a form this crosscheck cannot read — upgrade the CLI to see it",
    ],
  ] as const)("the skeleton line: %s", async (_label, retention, skeleton, expected) => {
    // Act
    const output = await fakeHubDoctor({ sessions: [], retention, skeleton });

    // Assert
    expect(output).toContain(expected);
  });

  test.each([
    [
      "a hub from before the field",
      { sessions: [] },
      "PASS  session-event retention  not measured",
    ],
    [
      "a hub with a mode this CLI cannot name",
      { sessions: [], retention: "referential-2099" },
      "PASS  session-event retention  the hub declares a retention mode this crosscheck cannot name — upgrade the CLI to read what it keeps",
    ],
  ] as const)(
    "%s is never printed as a retention it did not declare",
    async (_label, body, expected) => {
      // Arrange: ABSENT IS NOT OFF, and UNKNOWN IS NOT OFF either. A hub that
      // says nothing has made no promise about its rows, and one that names a
      // mode this connector cannot read may be deleting them — printing the
      // withdrawal sentence for either would be a statement nobody made. The
      // unknown mode is not echoed: it is not ours to render.
      const fake = Bun.serve({
        port: 0,
        fetch: (request) =>
          new URL(request.url).pathname === "/api/sessions/order"
            ? Response.json({ ok: true, data: body })
            : Response.json(
                { ok: false, error: { code: "not_found", message: "not here" } },
                { status: 404 },
              ),
      });
      const home = await makeHome("seq-doctor-hub-retention-fake");
      const repo = await makeRepo("seq-doctor-hub-retention-fake", {
        remote: "git@github.com:acme/api.git",
      });
      paths.push(home, repo);

      try {
        // Act
        const result = await runCli(
          ["doctor"],
          {
            CROSSCHECK_HOME: home,
            CROSSCHECK_HUB_URL: `http://127.0.0.1:${String(fake.port)}`,
            CROSSCHECK_API_KEY: "k",
            CROSSCHECK_SSH_CANONICALIZE: "off",
          },
          repo,
        );

        // Assert
        expect(result.stdout).toContain(expected);
        expect(result.stdout).not.toContain("nothing deletes session events");
        expect(result.stdout).not.toContain("referential-2099");
      } finally {
        fake.stop(true);
      }
    },
  );

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
