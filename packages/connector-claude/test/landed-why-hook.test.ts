/**
 * THE WHY IN THE STOP, end to end through `runHook` and a real hub
 * (docs/1.0/landed-changes.md, step 3).
 *
 * Mike worked on src/lines.ts in a Crosscheck session, committed, and the
 * change landed on staging; Nick's branch does not have it. Nick's edit is
 * stopped (step 1) — and now the stop also names Mike's work on the file
 * before it landed, with its intent, one get_diagnosis away from the rest.
 *
 * Pinned here: the real hub's match reaches the stop; the hub is asked only
 * when there IS a stop, the moment git answers; a slow hub costs the why and
 * never the stop or the hook's budget; an old hub (no such route) and an
 * author the hub does not know cost the why only; a match for a commit the
 * stop did not name is not printed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { createDb, createServer } from "@crosscheck/server";

import { runHook } from "../src/index.ts";
import { landedWhyFor } from "../src/hooks/landed-why.ts";
import type { Env } from "../src/index.ts";
import {
  SessionStateSchema,
  writeSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import { resolveRepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import { makeHome } from "../../connector-core/test/helpers.ts";
import {
  KEN,
  landWithMergeCommit,
  makeLandingRepos,
  readerFetches,
} from "../../connector-core/test/fixtures/landing-repos.ts";
import type { LandingRepos, Person } from "../../connector-core/test/fixtures/landing-repos.ts";

const ADMIN_TOKEN = "landed-why-admin";
const SESSION_ID = "landed-why-uuid";
const FILE = "src/lines.ts";
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const HEAVY_SETUP_MS = 60_000;
const TITLE = "Line offsets are off by one";
const INTENT = "Make line offsets one-based everywhere";
/** The PreToolUse budget at the default hub timeout (400 ms × 2), plus slop. */
const HOOK_CEILING_MS = 800 + 400;

const paths: string[] = [];
const servers: { stop: (force?: boolean) => void }[] = [];

afterEach(async () => {
  for (const server of servers) {
    server.stop(true);
  }
  servers.length = 0;
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();

interface Account {
  readonly developerId: string;
  readonly apiKey: string;
}

/** A real hub whose clock can be set back, so a session can START before a commit. */
const startRealHub = async (): Promise<{ url: string; setOffset: (ms: number) => void }> => {
  let offsetMs = 0;
  const server = Bun.serve({
    port: 0,
    fetch: createServer({
      db: await createDb(),
      adminToken: ADMIN_TOKEN,
      now: () => new Date(Date.now() + offsetMs),
    }).fetch,
  });
  servers.push(server);
  return {
    url: `http://127.0.0.1:${String(server.port)}`,
    setOffset: (ms) => {
      offsetMs = ms;
    },
  };
};

const post = (url: string, path: string, key: string, body: unknown): Promise<Response> =>
  fetch(`${url}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const account = async (url: string, person: Person): Promise<Account> => {
  const created = await post(url, "/api/developers", ADMIN_TOKEN, { name: person.name, email: person.email });
  const parsed = (await created.json()) as { data: { developer: { id: string }; apiKey: string } };
  return { developerId: parsed.data.developer.id, apiKey: parsed.data.apiKey };
};

/** Mike's session on the hub — started when the hub's clock says — and his work context on FILE. */
const mikeWorkedOn = async (url: string, mike: Account, repo: string): Promise<void> => {
  const sessionId = "cc_mike-uuid";
  const registered = await post(url, "/api/sessions", mike.apiKey, {
    id: sessionId,
    agentKind: "claude-code",
    repo,
    branch: "mike/offsets",
    baseCommit: "a1b2c3d4",
    status: "implementing",
  });
  expect(registered.status).toBe(200);
  const envelope = (kind: string, body: Record<string, unknown>) => ({
    cx: "0.1",
    id: `env_${crypto.randomUUID()}`,
    ts: new Date().toISOString(),
    producer: { developerId: mike.developerId, agentKind: "claude-code", sessionId },
    kind,
    body,
  });
  const seeded = await post(url, "/api/records", mike.apiKey, {
    records: [
      envelope("work_context", {
        id: "wc_mike",
        sessionId,
        title: TITLE,
        status: "implementing",
        createdAt: new Date().toISOString(),
        intent: { summary: INTENT, provenance: "declared", confidence: 1, capturedAt: new Date().toISOString() },
      }),
      envelope("target", { workContextId: "wc_mike", kind: "file", value: FILE }),
    ],
  });
  expect(((await seeded.json()) as { data: { rejected: number } }).data.rejected).toBe(0);
};

interface Fixture {
  readonly repos: LandingRepos;
  readonly home: string;
  readonly repoId: string;
}

const fixture = async (label: string, hubUrl: string): Promise<Fixture> => {
  const repos = await makeLandingRepos(label);
  const home = await makeHome(label);
  paths.push(repos.base, home);
  const identity = await resolveRepoIdentity(repos.reader);
  if (identity === null) {
    throw new Error("the reader clone has no repo identity");
  }
  await writeSessionState(
    home,
    SessionStateSchema.parse({
      hostSessionKey: SESSION_ID,
      crosscheckSessionId: `cc_${SESSION_ID}`,
      workContextId: `wc_cc_${SESSION_ID}`,
      repoId: identity.repoId,
      repoRoot: repos.reader,
      hubUrl,
      developerId: "dev_nick",
      startedAt: new Date().toISOString(),
    }),
  );
  return { repos, home, repoId: identity.repoId };
};

const envFor = (fix: Fixture, hubUrl: string, apiKey: string): Env => ({
  CROSSCHECK_HOME: fix.home,
  CROSSCHECK_HUB_URL: hubUrl,
  CROSSCHECK_API_KEY: apiKey,
  TZ: "Europe/Berlin",
  // These tests fetch the reader clone themselves.
  CROSSCHECK_LANDING_FETCH: "off",
});

/**
 * For tests about WHAT the why says, not WHEN: a wider hub timeout (and so
 * budget), so a slow CI machine's git cannot spend the room the why needs.
 * The budget tests below keep the default.
 */
const roomyEnvFor = (fix: Fixture, hubUrl: string, apiKey: string): Env => ({
  ...envFor(fix, hubUrl, apiKey),
  CROSSCHECK_TIMEOUT_MS: "1500",
});

/** Mike's change to FILE, committed an hour ago and merged into staging since. */
const mikeLands = (repos: LandingRepos, author?: Person) =>
  landWithMergeCommit(repos, {
    file: FILE,
    content: "export const offset = 2;\n",
    subject: "Fix line offset",
    landing: "staging",
    writtenAt: iso(-HOUR_MS),
    landedAt: iso(-30 * MINUTE_MS),
    ...(author === undefined ? {} : { author }),
  });

let toolUse = 0;

const editPayload = (repo: string): string => {
  toolUse += 1;
  return JSON.stringify({
    session_id: SESSION_ID,
    cwd: repo,
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_use_id: `toolu_why_${String(toolUse)}`,
    tool_input: { file_path: `${repo}/${FILE}` },
  });
};

const reasonOf = (stdout: string): string =>
  stdout.length === 0
    ? ""
    : ((JSON.parse(stdout) as { hookSpecificOutput?: { permissionDecisionReason?: string } }).hookSpecificOutput
        ?.permissionDecisionReason ?? "");

describe("the why behind a landed change, from a real hub", () => {
  test(
    "the stop names Mike's work on the file before it landed, with its intent",
    async () => {
      // Arrange — Mike's session started two hours ago, before his commit
      const hub = await startRealHub();
      const fix = await fixture("why-real", hub.url);
      const nick = await account(hub.url, { name: "Nick", email: "nick@example.com" });
      const mike = await account(hub.url, { name: "Mike", email: "mike@example.com" });
      hub.setOffset(-2 * HOUR_MS);
      await mikeWorkedOn(hub.url, mike, fix.repoId);
      hub.setOffset(0);
      await mikeLands(fix.repos);
      await readerFetches(fix.repos);

      // Act
      const reason = reasonOf(await runHook("pre-tool-use", editPayload(fix.repos.reader), roomyEnvFor(fix, hub.url, nick.apiKey)));

      // Assert
      expect(reason).toContain("«Fix line offset» by Mike, on staging");
      expect(reason).toContain(
        `Mike's work on ${FILE} before it landed (started 2h ago): work context «${TITLE}», readable with get_diagnosis wc_mike.`,
      );
      expect(reason).toContain(`Their intent: «${INTENT}»`);
      expect(reason).not.toContain("mike@example.com");
    },
    HEAVY_SETUP_MS,
  );

  test(
    "an author the hub does not know costs the why, never the stop",
    async () => {
      const hub = await startRealHub();
      const fix = await fixture("why-unknown", hub.url);
      const nick = await account(hub.url, { name: "Nick", email: "nick@example.com" });
      await mikeLands(fix.repos, KEN);
      await readerFetches(fix.repos);

      const reason = reasonOf(await runHook("pre-tool-use", editPayload(fix.repos.reader), roomyEnvFor(fix, hub.url, nick.apiKey)));

      expect(reason).toContain("«Fix line offset» by Ken, on staging");
      expect(reason).not.toContain("before it landed (");
    },
    HEAVY_SETUP_MS,
  );
});

interface FakeHub {
  readonly url: string;
  readonly contextCalls: () => number;
  /** How many commits each /api/landed/context question carried. */
  readonly askedCounts: () => readonly number[];
}

interface FakeLanded {
  readonly delayMs?: number;
  readonly status?: number;
  /** Answer for a commit the stop never named, instead of the first asked. */
  readonly foreignSha?: boolean;
  /** The live tripwire's answer: Mike active on the file, after this long. */
  readonly liveAfterMs?: number;
}

/**
 * A hub whose /api/landed/context is slow, missing, or matches the FIRST
 * commit it was asked about to Mike's work context.
 */
const startFakeHub = (landed: FakeLanded): FakeHub => {
  let calls = 0;
  const asked: number[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/landed/context") {
        calls += 1;
        const body = (await request.json()) as { commits: readonly { sha: string }[] };
        asked.push(body.commits.length);
        await Bun.sleep(landed.delayMs ?? 0);
        if ((landed.status ?? 200) !== 200) {
          return Response.json({ ok: false, error: { code: "not_found", message: "no route" } }, { status: landed.status ?? 404 });
        }
        const sha = landed.foreignSha === true ? "f".repeat(40) : (body.commits[0]?.sha ?? "");
        return Response.json({
          ok: true,
          data: { matches: [{ sha, workContextId: "wc_mike", title: TITLE, developerName: "Mike", intent: null }] },
        });
      }
      if (pathname === "/api/hints/tripwire") {
        if (landed.liveAfterMs === undefined) {
          return Response.json({ ok: true, data: { sessions: [] } });
        }
        await Bun.sleep(landed.liveAfterMs);
        return Response.json({
          ok: true,
          data: {
            sessions: [
              {
                sessionId: "cc_mike-live",
                developerId: "dev_mike",
                developerName: "Mike",
                branch: "mike/offsets",
                status: "implementing",
                lastHeartbeatAt: new Date().toISOString(),
                workContextId: "wc_mike_live",
                workContextTitle: "Still on it",
                workContextIntent: null,
              },
            ],
          },
        });
      }
      return Response.json({ ok: true, data: {} });
    },
  });
  servers.push(server);
  return {
    url: `http://127.0.0.1:${String(server.port)}`,
    contextCalls: () => calls,
    askedCounts: () => asked,
  };
};

describe("the hub is asked only when there is a stop, and never costs it", () => {
  test(
    "a slow hub costs the why, never the stop, and the hook stays inside its budget",
    async () => {
      const hub = startFakeHub({ delayMs: 3000 });
      const fix = await fixture("why-slow", hub.url);
      await mikeLands(fix.repos);
      await readerFetches(fix.repos);

      const started = performance.now();
      const reason = reasonOf(await runHook("pre-tool-use", editPayload(fix.repos.reader), envFor(fix, hub.url, "k")));
      const elapsed = performance.now() - started;

      // Asked once — or not at all, on a machine whose git spent the spare.
      expect(hub.contextCalls()).toBeLessThanOrEqual(1);
      expect(reason).toContain("«Fix line offset» by Mike, on staging");
      expect(reason).not.toContain("before it landed (");
      expect(elapsed).toBeLessThan(HOOK_CEILING_MS);
    },
    HEAVY_SETUP_MS,
  );

  test(
    "with the front of the budget spent on a slow live tripwire, the why gives way and both stops arrive",
    async () => {
      // The live half takes most of one hub timeout; what the budget still
      // spares after its reserve is little or nothing, and the why gets only
      // that (the clamp itself is pinned exactly below).
      const hub = startFakeHub({ delayMs: 3000, liveAfterMs: 300 });
      const fix = await fixture("why-live-slow", hub.url);
      await mikeLands(fix.repos);
      await readerFetches(fix.repos);

      const started = performance.now();
      const reason = reasonOf(await runHook("pre-tool-use", editPayload(fix.repos.reader), envFor(fix, hub.url, "k")));
      const elapsed = performance.now() - started;

      expect(reason).toContain("Mike has an active session");
      expect(reason).toContain("«Fix line offset» by Mike, on staging");
      expect(reason).not.toContain("before it landed (");
      expect(elapsed).toBeLessThan(800 + 150);
    },
    HEAVY_SETUP_MS,
  );

  test(
    "the why is asked when GIT answers, not after a slow live tripwire too",
    async () => {
      // With a 1500 ms hub timeout the spare is 1500 ms minus what came
      // before. The live half takes 1400 ms: a why asked only after it would
      // have under 100 ms, and this hub needs 100. Asked when git answered,
      // it has over a second — on a slow machine's git too.
      const hub = startFakeHub({ liveAfterMs: 1400, delayMs: 100 });
      const fix = await fixture("why-early", hub.url);
      await mikeLands(fix.repos);
      await readerFetches(fix.repos);

      const reason = reasonOf(await runHook("pre-tool-use", editPayload(fix.repos.reader), roomyEnvFor(fix, hub.url, "k")));

      expect(reason).toContain("«Fix line offset» by Mike, on staging");
      expect(reason).toContain("before it landed (");
    },
    HEAVY_SETUP_MS,
  );

  test(
    "a commit with a time no date can hold costs neither the stop nor the other commit's why",
    async () => {
      const hub = startFakeHub({});
      const fix = await fixture("why-hostile-time", hub.url);
      await mikeLands(fix.repos);
      await landWithMergeCommit(fix.repos, {
        file: FILE,
        content: "export const offset = 4;\n",
        subject: "From the far future",
        landing: "staging",
        writtenAt: "@99999999999999 +0000",
        landedAt: iso(-10 * MINUTE_MS),
      });
      await readerFetches(fix.repos);

      const reason = reasonOf(await runHook("pre-tool-use", editPayload(fix.repos.reader), roomyEnvFor(fix, hub.url, "k")));

      expect(reason).toContain("«From the far future» by Mike");
      expect(reason).toContain("«Fix line offset» by Mike");
      expect(hub.askedCounts()).toEqual([1]);
      expect(reason).toContain("before it landed (");
    },
    HEAVY_SETUP_MS,
  );

  test(
    "a commit the hub would refuse is left out of the question, so the others keep their why",
    async () => {
      const hub = startFakeHub({});
      const fix = await fixture("why-bad-address", hub.url);
      await mikeLands(fix.repos);
      // A second landed commit whose author address is past the hub's bounds.
      await landWithMergeCommit(fix.repos, {
        file: FILE,
        content: "export const offset = 3;\n",
        subject: "Another change",
        landing: "staging",
        writtenAt: iso(-HOUR_MS),
        landedAt: iso(-20 * MINUTE_MS),
        author: { name: "Long", email: `${"x".repeat(330)}@example.com` },
      });
      await readerFetches(fix.repos);

      const reason = reasonOf(await runHook("pre-tool-use", editPayload(fix.repos.reader), roomyEnvFor(fix, hub.url, "k")));

      expect(hub.askedCounts()).toEqual([1]);
      expect(reason).toContain("before it landed (");
    },
    HEAVY_SETUP_MS,
  );

  test(
    "an older hub without the route costs the why only",
    async () => {
      const hub = startFakeHub({ status: 404 });
      const fix = await fixture("why-old-hub", hub.url);
      await mikeLands(fix.repos);
      await readerFetches(fix.repos);

      const reason = reasonOf(await runHook("pre-tool-use", editPayload(fix.repos.reader), roomyEnvFor(fix, hub.url, "k")));

      expect(reason).toContain("«Fix line offset» by Mike, on staging");
      expect(reason).not.toContain("before it landed (");
    },
    HEAVY_SETUP_MS,
  );

  test(
    "a match for a commit the stop did not name is not printed",
    async () => {
      const hub = startFakeHub({ foreignSha: true });
      const fix = await fixture("why-foreign", hub.url);
      await mikeLands(fix.repos);
      await readerFetches(fix.repos);

      const reason = reasonOf(await runHook("pre-tool-use", editPayload(fix.repos.reader), roomyEnvFor(fix, hub.url, "k")));

      expect(reason).toContain("«Fix line offset» by Mike, on staging");
      expect(reason).not.toContain("before it landed (");
    },
    HEAVY_SETUP_MS,
  );

  test(
    "an edit with nothing landed asks the hub nothing about it",
    async () => {
      const hub = startFakeHub({});
      const fix = await fixture("why-nothing", hub.url);

      const stdout = await runHook("pre-tool-use", editPayload(fix.repos.reader), envFor(fix, hub.url, "k"));

      expect(reasonOf(stdout)).toBe("");
      expect(hub.contextCalls()).toBe(0);
    },
    HEAVY_SETUP_MS,
  );

  test(
    "the second edit of a stopped file asks nothing: the stop is spent, and so is its why",
    async () => {
      const hub = startFakeHub({});
      const fix = await fixture("why-once", hub.url);
      await mikeLands(fix.repos);
      await readerFetches(fix.repos);

      const first = reasonOf(await runHook("pre-tool-use", editPayload(fix.repos.reader), roomyEnvFor(fix, hub.url, "k")));
      const second = await runHook("pre-tool-use", editPayload(fix.repos.reader), roomyEnvFor(fix, hub.url, "k"));

      expect(first).toContain("before it landed (");
      expect(second).toBe("");
      expect(hub.contextCalls()).toBe(1);
    },
    HEAVY_SETUP_MS,
  );
});

describe("the why's own clamp", () => {
  const landedOne = () => ({
    missing: [
      {
        sha: "0dcfc4e41e1f309f8a6d3056726744bb8ddd6133",
        shortSha: "0dcfc4e",
        authorName: "Mike",
        authorEmail: "mike@example.com",
        subject: "Fix line offset",
        committedAt: new Date(),
        branches: ["staging"],
        landedAt: null,
      },
    ],
    recent: [],
    moreMissing: false,
    unchecked: [],
    cleanKey: null,
  });

  /** Only what landedWhyFor reads of a hook's context. */
  const contextFor = (hubUrl: string) =>
    ({
      hub: { hubUrl, apiKey: "k", timeoutMs: 400, home: "/nonexistent", repoKey: "", now: () => new Date() },
      identity: { repoId: "local/acme/api" },
    }) as unknown as Parameters<typeof landedWhyFor>[0];

  test("the why gets no more than the budget still spares, however slow the hub", async () => {
    const hub = startFakeHub({ delayMs: 3000 });

    const started = performance.now();
    const why = await landedWhyFor(contextFor(hub.url), { spareMs: () => 200 }, FILE, landedOne());
    const elapsed = performance.now() - started;

    expect(why).toEqual({ matches: [], told: [] });
    expect(hub.contextCalls()).toBe(1);
    // One whole hub timeout would be 400 ms; the spare was 200, and a clamp
    // even a third too loose would show.
    expect(elapsed).toBeLessThan(260);
  });

  test("below the floor it is not asked at all", async () => {
    const hub = startFakeHub({});

    const why = await landedWhyFor(contextFor(hub.url), { spareMs: () => 30 }, FILE, landedOne());

    expect(why).toEqual({ matches: [], told: [] });
    expect(hub.contextCalls()).toBe(0);
  });
});
