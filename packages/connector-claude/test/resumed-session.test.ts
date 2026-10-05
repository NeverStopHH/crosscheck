/**
 * A RESUMED CONVERSATION IS CAPTURED AGAIN (pilot, 2026-10-05).
 *
 * Claude Code keeps ONE `session_id` for the whole life of a conversation:
 * a VS Code reload, an exit and `claude --resume`, each fires SessionEnd and
 * then SessionStart under the same id. SessionEnd ends the crosscheck session
 * on the hub, and an end the connector reported is final there — so the next
 * life registers one rung up (`~r1`, `~r2`, …). The ladder had three rungs:
 * the fourth life found every one ended, kept the base id the hub had just
 * refused, and every record it captured was rejected as a late write while
 * the spool cursor moved past it. The pilot's drop ledger held 225 `rejected`
 * records for one conversation resumed over a month.
 *
 * Every test here drives the real hooks against a real in-memory hub, on a
 * logged-in machine as the pilot's was, and asks the places the loss shows:
 * the hub's targets, its session rows, and the connector's drop ledger.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";

import { createDb, createServer, readCoverage } from "@crosscheck/server";
import type { Db } from "@crosscheck/server";
// By path: the reaper is the hub's own timer and has no export; a test that
// reaps the way it does has to reach it where it lives.
import { reapStaleSessions } from "../../server/src/services/sessions.ts";
import { saveConfig } from "@crosscheck/connector-core/config/config.ts";
import { sessionLineagePathForSlug, sessionSlug } from "@crosscheck/connector-core/config/paths.ts";
import { readDropDetail } from "@crosscheck/connector-core/spool/drops.ts";
import { readSessionState } from "@crosscheck/connector-core/state/session-state.ts";

import { repoKey, runHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import { makeHome, makeRepo, writeRepoFile } from "../../connector-core/test/helpers.ts";

const ADMIN_TOKEN = "resumed-admin-token";
const REPO_ID = "github.com/acme/api";
/** Wide enough that a cold PGlite query never trips the fail-open budget. */
const TEST_TIMEOUT_MS = "4000";
/** More end/resume cycles than the old three-rung ladder survived. */
const RESUME_CYCLES = 5;
/** Lives the old ladder could give one conversation: `cc_<id>`, `~r1`, `~r2`. */
const OLD_LADDER_RUNGS = 3;
/** Every `source` Claude Code documents for SessionStart. */
const SESSION_START_SOURCES = ["startup", "resume", "clear", "compact", "fork"] as const;
/** The sources that re-fire INSIDE a live conversation, with no SessionEnd before. */
const REFIRE_SOURCES = ["compact", "resume", "clear"] as const;

let db: Db;
let server: ReturnType<typeof Bun.serve>;
let proxy: ReturnType<typeof Bun.serve>;
let hubUrl: string;
let proxyUrl: string;
let apiKey: string;
let registerCalls = 0;
const cleanups: string[] = [];

interface Fixture {
  readonly home: string;
  readonly repo: string;
  readonly env: Env;
  readonly url: string;
}

interface FixtureOptions {
  readonly url?: string;
  readonly key?: string;
  readonly remote?: string;
}

const fixture = async (label: string, options: FixtureOptions = {}): Promise<Fixture> => {
  const url = options.url ?? hubUrl;
  const key = options.key ?? apiKey;
  const home = await makeHome(label);
  const repo = await makeRepo(label, { remote: options.remote ?? "git@github.com:acme/api.git" });
  cleanups.push(home, repo);
  // A LOGGED-IN machine, as the pilot's was: the stored login is where
  // SessionStart remembers the developer id, and a register the hub refuses
  // falls back to it — so a refused life sends records the hub can name.
  await saveConfig(home, { version: 1, hubUrl: url, apiKey: key });
  return {
    home,
    repo,
    url,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: url,
      CROSSCHECK_API_KEY: key,
      CROSSCHECK_TIMEOUT_MS: TEST_TIMEOUT_MS,
    },
  };
};

const createDeveloper = async (
  name: string,
  email: string,
): Promise<{ readonly id: string; readonly key: string }> => {
  const response = await fetch(`${hubUrl}/api/developers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, email }),
  });
  const body = (await response.json()) as {
    data: { developer: { id: string }; apiKey: string };
  };
  return { id: body.data.developer.id, key: body.data.apiKey };
};

const sessionStart = (fx: Fixture, sessionId: string, source: string): Promise<string> =>
  runHook(
    "session-start",
    JSON.stringify({ session_id: sessionId, cwd: fx.repo, hook_event_name: "SessionStart", source }),
    fx.env,
  );

const sessionEnd = (fx: Fixture, sessionId: string): Promise<string> =>
  runHook(
    "session-end",
    JSON.stringify({ session_id: sessionId, cwd: fx.repo, hook_event_name: "SessionEnd", reason: "other" }),
    fx.env,
  );

const edit = async (fx: Fixture, sessionId: string, file: string): Promise<void> => {
  await writeRepoFile(fx.repo, file, "export const a = 1;\n");
  await runHook(
    "post-tool-use",
    JSON.stringify({
      session_id: sessionId,
      cwd: fx.repo,
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: join(fx.repo, file) },
      tool_response: {},
    }),
    fx.env,
  );
};

/** Start, then end → resume `lives - 1` times: the conversation's ended lives. */
const liveAndEnd = async (fx: Fixture, sessionId: string, lives: number): Promise<void> => {
  await sessionStart(fx, sessionId, "startup");
  for (let life = 1; life < lives; life += 1) {
    await sessionEnd(fx, sessionId);
    await sessionStart(fx, sessionId, "resume");
  }
  await sessionEnd(fx, sessionId);
};

const capturedFiles = async (prefix: string): Promise<readonly string[]> => {
  const rows = await db.execute(
    sql`select value from work_context_targets where value like ${`${prefix}%`} order by value`,
  );
  return (rows.rows as { value: string }[]).map((row) => row.value);
};

interface SessionRow {
  readonly id: string;
  readonly ended: boolean;
  readonly reaped: boolean;
}

const sessionRows = async (sessionId: string): Promise<readonly SessionRow[]> => {
  const rows = await db.execute(sql`
    select id, ended_at is not null as ended, reaped_at is not null as reaped
      from agent_sessions where id like ${`cc_${sessionId}%`} order by started_at, id`);
  return rows.rows as unknown as SessionRow[];
};

const rejectedDrops = async (fx: Fixture): Promise<number> =>
  (await readDropDetail(fx.home, repoKey(fx.url, REPO_ID))).byReason["rejected"] ?? 0;

beforeAll(async () => {
  db = await createDb();
  const app = createServer({ db, adminToken: ADMIN_TOKEN });
  server = Bun.serve({ port: 0, fetch: app.fetch });
  hubUrl = `http://127.0.0.1:${server.port}`;
  // The same hub behind a counter of register calls: what a resume COSTS is
  // the number of round trips SessionStart spends before its briefing.
  proxy = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const { pathname, search } = new URL(request.url);
      if (request.method === "POST" && pathname === "/api/sessions") {
        registerCalls += 1;
      }
      return fetch(`${hubUrl}${pathname}${search}`, {
        method: request.method,
        headers: request.headers,
        body: request.method === "GET" ? undefined : await request.arrayBuffer(),
      });
    },
  });
  proxyUrl = `http://127.0.0.1:${proxy.port}`;
  apiKey = (await createDeveloper("Resumer", "resumer@example.com")).key;
});

afterAll(async () => {
  proxy.stop(true);
  server.stop(true);
  await (db as unknown as { $client: { close: () => Promise<void> } }).$client
    .close()
    .catch(() => undefined);
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

describe("a conversation resumed after SessionEnd", () => {
  test(`is captured in every one of ${String(RESUME_CYCLES + 1)} lives`, async () => {
    // Arrange: one conversation, one host session id for its whole life
    const fx = await fixture("resume-cycles");
    const sessionId = "resume-cycles-uuid";
    const expected: string[] = [];

    // Act: start, then edit → end → resume again and again
    await sessionStart(fx, sessionId, "startup");
    for (let cycle = 0; cycle <= RESUME_CYCLES; cycle += 1) {
      const file = `src/cycles/c${String(cycle)}.ts`;
      expected.push(file);
      await edit(fx, sessionId, file);
      if (cycle < RESUME_CYCLES) {
        await sessionEnd(fx, sessionId);
        await sessionStart(fx, sessionId, "resume");
      }
    }

    // Assert: every edit reached the hub, and nothing was refused
    expect(await capturedFiles("src/cycles/")).toEqual(expected);
    expect(await rejectedDrops(fx)).toBe(0);
  });

  for (const source of SESSION_START_SOURCES) {
    test(`SessionStart(${source}) after ${String(OLD_LADDER_RUNGS)} ended lives captures the next one`, async () => {
      // Arrange: a conversation that already used up the old ladder
      const fx = await fixture(`source-${source}`);
      const sessionId = `source-${source}-uuid`;
      await liveAndEnd(fx, sessionId, OLD_LADDER_RUNGS);

      // Act
      await sessionStart(fx, sessionId, source);
      await edit(fx, sessionId, `src/source-${source}/after.ts`);

      // Assert
      expect(await capturedFiles(`src/source-${source}/`)).toEqual([
        `src/source-${source}/after.ts`,
      ]);
      expect(await rejectedDrops(fx)).toBe(0);
    });
  }

  test("every life is its own hub session: the ended ones stay ended, append-only", async () => {
    // Arrange
    const fx = await fixture("append-only");
    const sessionId = "append-only-uuid";
    await liveAndEnd(fx, sessionId, OLD_LADDER_RUNGS);

    // Act
    await sessionStart(fx, sessionId, "resume");

    // Assert: three reported ends kept as they were, one open life beside them
    const base = `cc_${sessionId}`;
    expect(await sessionRows(sessionId)).toEqual([
      { id: base, ended: true, reaped: false },
      { id: `${base}~r1`, ended: true, reaped: false },
      { id: `${base}~r2`, ended: true, reaped: false },
      { id: `${base}~r3`, ended: false, reaped: false },
    ]);
    // ...and one epoch per life: no order is split across an end
    const epochs = await db.execute(sql`
      select session_id, count(distinct seq_epoch)::int as epochs
        from session_events where session_id like ${`${base}%`}
       group by session_id order by session_id`);
    expect((epochs.rows as { epochs: number }[]).map((row) => row.epochs)).toEqual([1, 1, 1, 1]);
  });

  test("a resume costs two register calls however many lives came before", async () => {
    // Arrange: four ended lives, behind the counting proxy
    const fx = await fixture("resume-cost", { url: proxyUrl });
    const sessionId = "resume-cost-uuid";
    await liveAndEnd(fx, sessionId, OLD_LADDER_RUNGS + 1);

    // Act
    const before = registerCalls;
    await sessionStart(fx, sessionId, "resume");

    // Assert: the ended life the last end wrote down, then the next rung
    expect(registerCalls - before).toBe(2);
    expect((await readSessionState(fx.home, sessionId))?.crosscheckSessionId).toBe(
      `cc_${sessionId}~r${String(OLD_LADDER_RUNGS + 1)}`,
    );
  });

  test("a lost lineage file still lands the next life — the walk gallops", async () => {
    // Arrange: ended lives, and the note of the last one gone
    const fx = await fixture("lost-lineage");
    const sessionId = "lost-lineage-uuid";
    await liveAndEnd(fx, sessionId, OLD_LADDER_RUNGS + 1);
    await rm(sessionLineagePathForSlug(fx.home, sessionSlug(sessionId)), { force: true });

    // Act
    await sessionStart(fx, sessionId, "resume");
    await edit(fx, sessionId, "src/lost-lineage/after.ts");

    // Assert
    expect(await capturedFiles("src/lost-lineage/")).toEqual(["src/lost-lineage/after.ts"]);
    expect(await rejectedDrops(fx)).toBe(0);
  });
});

describe("SessionStart re-firing inside a LIVE conversation (no SessionEnd before)", () => {
  for (const source of REFIRE_SOURCES) {
    test(`SessionStart(${source}) keeps the life it is in, for one register call`, async () => {
      // Arrange: a conversation on its second life, behind the counting proxy
      const fx = await fixture(`refire-${source}`, { url: proxyUrl });
      const sessionId = `refire-${source}-uuid`;
      await liveAndEnd(fx, sessionId, 1);
      await sessionStart(fx, sessionId, "resume");

      // Act
      const before = registerCalls;
      await sessionStart(fx, sessionId, source);
      await edit(fx, sessionId, `src/refire-${source}/after.ts`);

      // Assert: same life, no new hub session, nothing refused
      expect(registerCalls - before).toBe(1);
      expect((await readSessionState(fx.home, sessionId))?.crosscheckSessionId).toBe(
        `cc_${sessionId}~r1`,
      );
      expect((await sessionRows(sessionId)).length).toBe(2);
      expect(await capturedFiles(`src/refire-${source}/`)).toEqual([
        `src/refire-${source}/after.ts`,
      ]);
      expect(await rejectedDrops(fx)).toBe(0);
    });
  }
});

describe("a PostToolUse after SessionEnd with no SessionStart in between", () => {
  test("recovers into the next life instead of capturing nothing", async () => {
    // Arrange: ended lives, then the conversation continues without a
    // SessionStart this hook could see (the parent-workspace shape)
    const fx = await fixture("recover-after-end");
    const sessionId = "recover-after-end-uuid";
    await liveAndEnd(fx, sessionId, OLD_LADDER_RUNGS);

    // Act
    await edit(fx, sessionId, "src/recover/after.ts");

    // Assert
    expect(await capturedFiles("src/recover/")).toEqual(["src/recover/after.ts"]);
    expect(await rejectedDrops(fx)).toBe(0);
  });
});

/**
 * THE COVERAGE CAVEAT A DEAF CONVERSATION LEAVES (coordinator, 2026-10-05):
 * "commit authors with no reported session since …" on every briefing. The
 * git rung counts an author whose newest commit postdates their newest
 * reported session on the repo (server services/absences.ts
 * readAbsenceCensus). A life the ladder could not register touches NO session
 * row — the register is a 409, the heartbeat a 409, every record refused —
 * so the author's last session freezes while their commits go on. These run
 * on their own repo and developer, whose email is the fixture repo's author.
 */
describe("coverage once a conversation is captured again", () => {
  const COVERAGE_REMOTE = "git@github.com:acme/coverage.git";
  const COVERAGE_REPO_ID = "github.com/acme/coverage";

  const rung = async (viewerId: string, source: "agent_event" | "git") =>
    (await readCoverage({ db, now: () => new Date() }, viewerId, COVERAGE_REPO_ID)).sources.find(
      (row) => row.source === source,
    );

  test("the git rung closes on the resumed life's register — evidence, not time", async () => {
    // Arrange: the repo's commit author, three ended lives, and their last
    // live session two days behind the commits it is meant to cover
    const author = await createDeveloper("Committer", "dev@example.com");
    const fx = await fixture("coverage-git", { key: author.key, remote: COVERAGE_REMOTE });
    const sessionId = "coverage-git-uuid";
    await liveAndEnd(fx, sessionId, OLD_LADDER_RUNGS);
    await db.execute(sql`
      update agent_sessions set last_heartbeat_at = now() - interval '2 days'
       where repo = ${COVERAGE_REPO_ID}`);
    expect((await rung(author.id, "git"))?.reason).toBe("commit_authors_unreported");

    // Act: the conversation comes back
    await sessionStart(fx, sessionId, "resume");
    await edit(fx, sessionId, "src/coverage/after.ts");

    // Assert
    expect(await rung(author.id, "git")).toMatchObject({ state: "complete" });
    expect(await rung(author.id, "agent_event")).toMatchObject({ state: "complete" });
  });

  test("a reaped life that comes back is revived, and the reaped caveat goes with it", async () => {
    // Arrange: a live life killed without SessionEnd and reaped by the hub
    const viewer = await createDeveloper("Reaped", "reaped@example.com");
    const fx = await fixture("coverage-reaped", { key: viewer.key, remote: COVERAGE_REMOTE });
    const sessionId = "coverage-reaped-uuid";
    await liveAndEnd(fx, sessionId, OLD_LADDER_RUNGS);
    await sessionStart(fx, sessionId, "resume");
    await reapStaleSessions({ db, now: () => new Date() }, { staleHours: 0, developerId: viewer.id });
    expect(await rung(viewer.id, "agent_event")).toMatchObject({
      state: "incomplete",
      reason: "session_reaped",
    });

    // Act: the conversation comes back without a SessionEnd in between
    await sessionStart(fx, sessionId, "resume");

    // Assert: the same life, reopened — not a fresh one beside the corpse
    expect((await readSessionState(fx.home, sessionId))?.crosscheckSessionId).toBe(
      `cc_${sessionId}~r${String(OLD_LADDER_RUNGS)}`,
    );
    expect((await rung(viewer.id, "agent_event"))?.state).not.toBe("incomplete");
  });
});
