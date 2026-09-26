/**
 * THE WHY BEHIND A LANDED CHANGE (docs/1.0/landed-changes.md, step 3).
 *
 * When the pre-edit stop names a teammate's commit, the hub is asked whose
 * work that was: the same person (the commit's author address, mapped to a
 * developer), the same file (a work context that targeted it), and work that
 * started before the commit (the session's start). A probable match, said as
 * one (decision 6) — the hub keeps no table of commits, and a squash lands
 * under a new sha anyway.
 *
 * Pinned here: which work context is named, which never is (the caller's
 * own, a muted teammate's, one from a session started after the commit, one
 * on another file or repo), that an alias address counts, that no address is
 * ever echoed in the answer, and the doctor half: which addresses belong to
 * nobody (decision 7).
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { agentSessions } from "../src/db/schema.ts";

import {
  TEST_ADMIN_TOKEN,
  TEST_START_ISO,
  VALID_SESSION_BODY,
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  validWorkContextBody,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = VALID_SESSION_BODY.repo;
const FILE = "src/lines.ts";
const MIKE_EMAIL = "mike@example.com";
const SHA = "a".repeat(40);
const HOUR_S = 3600;
const T0_MS = Date.parse(TEST_START_ISO);
const at = (seconds: number): string => new Date(T0_MS + seconds * 1000).toISOString();

const INTENT = {
  summary: "Make line offsets one-based everywhere",
  provenance: "declared",
  confidence: 1,
  capturedAt: TEST_START_ISO,
} as const;

interface Team {
  readonly harness: TestHarness;
  readonly nick: TestDeveloper;
  readonly mike: TestDeveloper;
}

/** Nick (the reader) and Mike (the teammate), each with a session at T0. */
const team = async (): Promise<Team> => {
  const harness = await createTestHarness();
  const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
  await registerTestSession(harness, nick.apiKey, { id: "ses_nick" });
  const mike = await createTestDeveloper(harness, "Mike", MIKE_EMAIL);
  return { harness, nick, mike };
};

/**
 * One session of Mike's, started NOW on the harness clock, with a work
 * context that targeted `file`.
 */
const mikeWorks = async (
  t: Team,
  input: { readonly session: string; readonly context: string; readonly title: string; readonly file?: string; readonly repo?: string },
): Promise<void> => {
  const registered = await registerTestSession(t.harness, t.mike.apiKey, {
    id: input.session,
    ...(input.repo === undefined ? {} : { repo: input.repo }),
  });
  expect(registered.status).toBe(200);
  const seeded = await postRecords(t.harness, t.mike, {
    records: [
      recordEnvelope(
        "work_context",
        validWorkContextBody({ id: input.context, sessionId: input.session, title: input.title, intent: INTENT }),
        { sessionId: input.session },
      ),
      recordEnvelope(
        "target",
        { workContextId: input.context, kind: "file", value: input.file ?? FILE },
        { sessionId: input.session },
      ),
    ],
  });
  expect(seeded.data?.accepted).toBe(2);
};

interface Match {
  readonly sha: string;
  readonly workContextId: string;
  readonly title: string;
  readonly developerName: string;
  readonly intent: { readonly summary: string; readonly provenance: string } | null;
  readonly workStartedAt: string;
}

const askContext = async (
  t: Team,
  caller: TestDeveloper,
  commits: readonly { sha: string; authorEmail: string; committedAt: string }[],
  overrides: Record<string, unknown> = {},
): Promise<{ status: number; matches: readonly Match[]; raw: string }> => {
  const response = await t.harness.app.request(
    "/api/landed/context",
    jsonRequest("POST", caller.apiKey, { repo: REPO, path: FILE, commits, ...overrides }),
  );
  const raw = await response.text();
  const matches =
    response.status === 200 ? (JSON.parse(raw) as { data: { matches: Match[] } }).data.matches : [];
  return { status: response.status, matches, raw };
};

const commitBy = (authorEmail: string, committedAt: string, sha: string = SHA) => ({
  sha,
  authorEmail,
  committedAt,
});

describe("POST /api/landed/context", () => {
  test("names the author's work context on the file, from a session started before the commit", async () => {
    // Arrange
    const t = await team();
    await mikeWorks(t, { session: "ses_mike", context: "wc_mike", title: "Line offsets are off by one" });

    // Act — Mike's commit came an hour after his session started
    const answer = await askContext(t, t.nick, [commitBy(MIKE_EMAIL, at(HOUR_S))]);

    // Assert
    expect(answer.status).toBe(200);
    expect(answer.matches).toEqual([
      {
        sha: SHA,
        workContextId: "wc_mike",
        title: "Line offsets are off by one",
        developerName: "Mike",
        intent: expect.objectContaining({ summary: INTENT.summary, provenance: "declared" }),
        workStartedAt: TEST_START_ISO,
      },
    ]);
  });

  test("a session started after the commit is not the work behind it", async () => {
    const t = await team();
    t.harness.clock.advanceSeconds(2 * HOUR_S);
    await mikeWorks(t, { session: "ses_mike_later", context: "wc_later", title: "Something afterwards" });

    const answer = await askContext(t, t.nick, [commitBy(MIKE_EMAIL, at(HOUR_S))]);

    expect(answer.matches).toEqual([]);
  });

  test("of several, the latest work started before the commit is named", async () => {
    // Arrange — Mike worked on the file at T0 and again at T0+30m
    const t = await team();
    await mikeWorks(t, { session: "ses_mike_1", context: "wc_first", title: "First pass" });
    t.harness.clock.advanceSeconds(HOUR_S / 2);
    await mikeWorks(t, { session: "ses_mike_2", context: "wc_second", title: "Second pass" });

    // Act — one commit after both, one between them
    const later = await askContext(t, t.nick, [commitBy(MIKE_EMAIL, at(HOUR_S))]);
    const between = await askContext(t, t.nick, [commitBy(MIKE_EMAIL, at(HOUR_S / 4))]);

    // Assert
    expect(later.matches.map((match) => match.workContextId)).toEqual(["wc_second"]);
    expect(between.matches.map((match) => match.workContextId)).toEqual(["wc_first"]);
  });

  test("two commits in one question are each matched to the work before THEM", async () => {
    // The SQL bound is the LATEST commit; the earlier commit must still not
    // be given work that started after it.
    const t = await team();
    await mikeWorks(t, { session: "ses_mike_1", context: "wc_first", title: "First pass" });
    t.harness.clock.advanceSeconds(HOUR_S / 2);
    await mikeWorks(t, { session: "ses_mike_2", context: "wc_second", title: "Second pass" });
    const early = "c".repeat(40);

    const answer = await askContext(t, t.nick, [
      commitBy(MIKE_EMAIL, at(HOUR_S)),
      commitBy(MIKE_EMAIL, at(HOUR_S / 4), early),
    ]);

    expect(answer.matches.map((match) => [match.sha, match.workContextId])).toEqual([
      [SHA, "wc_second"],
      [early, "wc_first"],
    ]);
  });

  test("answers each commit on its own, and a commit with no match is simply absent", async () => {
    const t = await team();
    await mikeWorks(t, { session: "ses_mike", context: "wc_mike", title: "Line offsets are off by one" });
    const other = "b".repeat(40);

    const answer = await askContext(t, t.nick, [
      commitBy(MIKE_EMAIL, at(HOUR_S)),
      commitBy("stranger@example.com", at(HOUR_S), other),
    ]);

    expect(answer.matches.map((match) => match.sha)).toEqual([SHA]);
  });

  test("never the caller's own work", async () => {
    const t = await team();
    const seeded = await postRecords(t.harness, t.nick, {
      records: [
        recordEnvelope("work_context", validWorkContextBody({ id: "wc_nick", sessionId: "ses_nick", title: "Mine" }), {
          sessionId: "ses_nick",
        }),
        recordEnvelope("target", { workContextId: "wc_nick", kind: "file", value: FILE }, { sessionId: "ses_nick" }),
      ],
    });
    expect(seeded.data?.accepted).toBe(2);

    const answer = await askContext(t, t.nick, [commitBy("nick@example.com", at(HOUR_S))]);

    expect(answer.matches).toEqual([]);
  });

  test("a teammate the caller muted is left out — this is an unasked surface", async () => {
    const t = await team();
    await mikeWorks(t, { session: "ses_mike", context: "wc_mike", title: "Line offsets are off by one" });
    const muted = await t.harness.app.request(
      "/api/settings/mutes",
      jsonRequest("POST", t.nick.apiKey, { developer: MIKE_EMAIL }),
    );
    expect(muted.status).toBe(200);

    const answer = await askContext(t, t.nick, [commitBy(MIKE_EMAIL, at(HOUR_S))]);

    expect(answer.matches).toEqual([]);
  });

  test("a presence opt-out hides the work while its session is live, and not after", async () => {
    // Arrange — Mike opted out of presence; his session is live at first
    const t = await team();
    await mikeWorks(t, { session: "ses_mike", context: "wc_mike", title: "Line offsets are off by one" });
    const optedOut = await t.harness.app.request(
      "/api/settings/presence",
      jsonRequest("PUT", t.mike.apiKey, { optOut: true }),
    );
    expect(optedOut.status).toBe(200);

    // Act — while live, then once the session has gone quiet
    const whileLive = await askContext(t, t.nick, [commitBy(MIKE_EMAIL, at(HOUR_S))]);
    t.harness.clock.advanceSeconds(HOUR_S);
    const afterwards = await askContext(t, t.nick, [commitBy(MIKE_EMAIL, at(HOUR_S))]);

    // Assert — a live session is presence; a finished one is published work
    expect(whileLive.matches).toEqual([]);
    expect(afterwards.matches.map((match) => match.workContextId)).toEqual(["wc_mike"]);
  });

  test("work from a session long gone is not offered for a commit made outside any", async () => {
    // Mike's last session on the file was at T0; the commit came 180 days later.
    const t = await team();
    await mikeWorks(t, { session: "ses_mike_march", context: "wc_march", title: "Back in March" });

    const answer = await askContext(t, t.nick, [commitBy(MIKE_EMAIL, at(180 * 24 * HOUR_S))]);

    expect(answer.matches).toEqual([]);
  });

  test("a session that had already edited the file wins over one that only touched it after the commit", async () => {
    // S1 edited the file at T0; S2 started at T0+10m but touched the file
    // only at T0+2h — after the commit at T0+20m.
    const t = await team();
    await mikeWorks(t, { session: "ses_mike_work", context: "wc_the_work", title: "The work" });
    t.harness.clock.advanceSeconds(10 * 60);
    const registered = await registerTestSession(t.harness, t.mike.apiKey, { id: "ses_mike_next" });
    expect(registered.status).toBe(200);
    t.harness.clock.advanceSeconds(110 * 60);
    const later = await postRecords(t.harness, t.mike, {
      records: [
        recordEnvelope("work_context", validWorkContextBody({ id: "wc_followup", sessionId: "ses_mike_next", title: "Follow-up" }), {
          sessionId: "ses_mike_next",
        }),
        recordEnvelope("target", { workContextId: "wc_followup", kind: "file", value: FILE }, { sessionId: "ses_mike_next" }),
      ],
    });
    expect(later.data?.accepted).toBe(2);

    const answer = await askContext(t, t.nick, [commitBy(MIKE_EMAIL, at(20 * 60))]);

    expect(answer.matches.map((match) => match.workContextId)).toEqual(["wc_the_work"]);
  });

  test("a follow-up that touched the file within the hour after the commit does not take the credit", async () => {
    // S1 edited the file at T0; S2 started at T0+10m and touched the file
    // at T0+49m — 29 minutes after the commit at T0+20m, inside the hour a
    // late spool flush is allowed, but still after the commit.
    const t = await team();
    await mikeWorks(t, { session: "ses_mike_work", context: "wc_the_work", title: "The work" });
    t.harness.clock.advanceSeconds(10 * 60);
    expect((await registerTestSession(t.harness, t.mike.apiKey, { id: "ses_mike_next" })).status).toBe(200);
    t.harness.clock.advanceSeconds(39 * 60);
    const later = await postRecords(t.harness, t.mike, {
      records: [
        recordEnvelope("work_context", validWorkContextBody({ id: "wc_followup_29", sessionId: "ses_mike_next", title: "Follow-up" }), {
          sessionId: "ses_mike_next",
        }),
        recordEnvelope("target", { workContextId: "wc_followup_29", kind: "file", value: FILE }, { sessionId: "ses_mike_next" }),
      ],
    });
    expect(later.data?.accepted).toBe(2);

    const answer = await askContext(t, t.nick, [commitBy(MIKE_EMAIL, at(20 * 60))]);

    expect(answer.matches.map((match) => match.workContextId)).toEqual(["wc_the_work"]);
  });

  test("a session the reaper ended late counts from its last heartbeat, not the reap", async () => {
    // Mike's session went quiet at T0; the hub was down, so the reaper only
    // ended it 50 days later. The commit came 55 days after T0.
    const t = await team();
    await mikeWorks(t, { session: "ses_mike_before_break", context: "wc_before_break", title: "Before the break" });
    const reapedAt = new Date(T0_MS + 50 * 24 * HOUR_S * 1000);
    await t.harness.db
      .update(agentSessions)
      .set({ endedAt: reapedAt, reapedAt })
      .where(eq(agentSessions.id, "ses_mike_before_break"));

    const answer = await askContext(t, t.nick, [commitBy(MIKE_EMAIL, at(55 * 24 * HOUR_S))]);

    expect(answer.matches).toEqual([]);
  });

  test("an end the hub received days late is not a sign of life", async () => {
    // Mike's last heartbeat was at T0; his SessionEnd was deferred through
    // the spool and reached the hub six days later. The commit came at T0+35d.
    const t = await team();
    await mikeWorks(t, { session: "ses_mike_quiet", context: "wc_quiet", title: "Went quiet" });
    t.harness.clock.advanceSeconds(6 * 24 * HOUR_S);
    const ended = await t.harness.app.request("/api/sessions/ses_mike_quiet/end", jsonRequest("POST", t.mike.apiKey, {}));
    expect(ended.status).toBe(200);

    const answer = await askContext(t, t.nick, [commitBy(MIKE_EMAIL, at(35 * 24 * HOUR_S))]);

    expect(answer.matches).toEqual([]);
  });

  test("an opted-out teammate's session that has just ENDED is published work, not presence", async () => {
    const t = await team();
    await mikeWorks(t, { session: "ses_mike", context: "wc_mike", title: "Line offsets are off by one" });
    await t.harness.app.request("/api/settings/presence", jsonRequest("PUT", t.mike.apiKey, { optOut: true }));
    const ended = await t.harness.app.request("/api/sessions/ses_mike/end", jsonRequest("POST", t.mike.apiKey, {}));
    expect(ended.status).toBe(200);

    // Well inside the presence TTL: only the END makes it not live.
    const answer = await askContext(t, t.nick, [commitBy(MIKE_EMAIL, at(HOUR_S))]);

    expect(answer.matches.map((match) => match.workContextId)).toEqual(["wc_mike"]);
  });

  test("a commit time the hub's arithmetic cannot hold is refused, not a 500", async () => {
    const t = await team();

    const ancient = await askContext(t, t.nick, [commitBy(MIKE_EMAIL, "0001-01-01T00:00:00.000Z")]);
    const far = await askContext(t, t.nick, [commitBy(MIKE_EMAIL, "9999-12-31T23:59:00.000Z")]);

    expect(ancient.status).toBe(400);
    expect(far.status).toBe(400);
  });

  test("a session started a minute after the commit on the hub's clock still counts: laptops drift", async () => {
    const t = await team();
    await mikeWorks(t, { session: "ses_mike_old", context: "wc_last_week", title: "Last week" });
    t.harness.clock.advanceSeconds(HOUR_S);
    await mikeWorks(t, { session: "ses_mike_now", context: "wc_now", title: "Now" });

    // The commit's time, from Mike's laptop, reads a minute BEFORE the hub
    // saw his current session start.
    const answer = await askContext(t, t.nick, [commitBy(MIKE_EMAIL, at(HOUR_S - 60))]);

    expect(answer.matches.map((match) => match.workContextId)).toEqual(["wc_now"]);
  });

  test("a busy author on the file never crowds out another commit's match", async () => {
    const t = await team();
    const ken = await createTestDeveloper(t.harness, "Ken", "ken@example.com");
    await registerTestSession(t.harness, ken.apiKey, { id: "ses_ken" });
    const kenSeeded = await postRecords(t.harness, ken, {
      records: [
        recordEnvelope("work_context", validWorkContextBody({ id: "wc_ken", sessionId: "ses_ken", title: "Ken's" }), {
          sessionId: "ses_ken",
        }),
        recordEnvelope("target", { workContextId: "wc_ken", kind: "file", value: FILE }, { sessionId: "ses_ken" }),
      ],
    });
    expect(kenSeeded.data?.accepted).toBe(2);
    for (const n of [1, 2, 3]) {
      t.harness.clock.advanceSeconds(60);
      await mikeWorks(t, { session: `ses_mike_${String(n)}`, context: `wc_mike_${String(n)}`, title: `Pass ${String(n)}` });
    }

    const answer = await askContext(t, t.nick, [
      commitBy(MIKE_EMAIL, at(HOUR_S)),
      commitBy("ken@example.com", at(HOUR_S), "d".repeat(40)),
    ]);

    expect(answer.matches.map((match) => match.workContextId)).toEqual(["wc_mike_3", "wc_ken"]);
  });

  test("the file is matched in its one spelling, however it was asked", async () => {
    const t = await team();
    await mikeWorks(t, { session: "ses_mike", context: "wc_mike", title: "Line offsets are off by one" });

    const answer = await askContext(t, t.nick, [commitBy(MIKE_EMAIL, at(HOUR_S))], { path: "./src//lines.ts" });

    expect(answer.matches.map((match) => match.workContextId)).toEqual(["wc_mike"]);
  });

  test("a commit time with an offset is read, not refused", async () => {
    const t = await team();
    await mikeWorks(t, { session: "ses_mike", context: "wc_mike", title: "Line offsets are off by one" });
    // T0 + 1h, written in +02:00.
    const withOffset = new Date(T0_MS + HOUR_S * 1000 + 2 * HOUR_S * 1000).toISOString().replace("Z", "+02:00");

    const answer = await askContext(t, t.nick, [commitBy(MIKE_EMAIL, withOffset)]);

    expect(answer.status).toBe(200);
    expect(answer.matches.map((match) => match.workContextId)).toEqual(["wc_mike"]);
  });

  test("another file or another repo is not this file's work", async () => {
    const t = await team();
    await mikeWorks(t, { session: "ses_mike", context: "wc_other_file", title: "Elsewhere", file: "src/other.ts" });
    await mikeWorks(t, {
      session: "ses_mike_web",
      context: "wc_other_repo",
      title: "Other repo",
      repo: "github.com/acme/web",
    });

    const answer = await askContext(t, t.nick, [commitBy(MIKE_EMAIL, at(HOUR_S))]);

    expect(answer.matches).toEqual([]);
  });

  test("an address an admin linked to Mike counts as Mike's, in any case", async () => {
    const t = await team();
    await mikeWorks(t, { session: "ses_mike", context: "wc_mike", title: "Line offsets are off by one" });
    const alias = "12345+mike@users.noreply.github.com";
    const linked = await t.harness.app.request(
      `/api/developers/${t.mike.developerId}/emails`,
      jsonRequest("POST", TEST_ADMIN_TOKEN, { email: alias }),
    );
    expect(linked.status).toBe(200);

    const viaAlias = await askContext(t, t.nick, [commitBy(alias, at(HOUR_S))]);
    const shouting = await askContext(t, t.nick, [commitBy("MIKE@Example.COM", at(HOUR_S))]);

    expect(viaAlias.matches.map((match) => match.workContextId)).toEqual(["wc_mike"]);
    expect(shouting.matches.map((match) => match.workContextId)).toEqual(["wc_mike"]);
  });

  test("the answer never carries an address", async () => {
    const t = await team();
    await mikeWorks(t, { session: "ses_mike", context: "wc_mike", title: "Line offsets are off by one" });

    const answer = await askContext(t, t.nick, [commitBy(MIKE_EMAIL, at(HOUR_S))]);

    expect(answer.matches).toHaveLength(1);
    expect(answer.raw).not.toContain(MIKE_EMAIL);
    expect(answer.raw).not.toContain("@");
  });

  test("an unreadable question is refused, not guessed at", async () => {
    const t = await team();

    const tooMany = await askContext(
      t,
      t.nick,
      Array.from({ length: 11 }, (_, index) => commitBy(MIKE_EMAIL, at(HOUR_S), index.toString(16).padStart(40, "0"))),
    );
    const badSha = await askContext(t, t.nick, [commitBy(MIKE_EMAIL, at(HOUR_S), "not-a-sha")]);
    const noPath = await askContext(t, t.nick, [commitBy(MIKE_EMAIL, at(HOUR_S))], { path: "" });
    const noKey = await t.harness.app.request(
      "/api/landed/context",
      jsonRequest("POST", null, { repo: REPO, path: FILE, commits: [commitBy(MIKE_EMAIL, at(HOUR_S))] }),
    );

    expect(tooMany.status).toBe(400);
    expect(badSha.status).toBe(400);
    expect(noPath.status).toBe(400);
    expect(noKey.status).toBe(401);
  });
});

describe("POST /api/landed/authors", () => {
  const askAuthors = async (t: Team, emails: readonly string[]) => {
    const response = await t.harness.app.request(
      "/api/landed/authors",
      jsonRequest("POST", t.nick.apiKey, { repo: REPO, emails }),
    );
    return {
      status: response.status,
      unknown: response.status === 200 ? ((await response.json()) as { data: { unknown: string[] } }).data.unknown : [],
    };
  };

  test("names the addresses that belong to nobody on this hub, as they were asked", async () => {
    const t = await team();

    const answer = await askAuthors(t, [MIKE_EMAIL, "Mike@Example.com", "12345+mike@users.noreply.github.com"]);

    expect(answer.status).toBe(200);
    expect(answer.unknown).toEqual(["12345+mike@users.noreply.github.com"]);
  });

  test("an address linked since is no longer unknown", async () => {
    const t = await team();
    const alias = "12345+mike@users.noreply.github.com";
    await t.harness.app.request(
      `/api/developers/${t.mike.developerId}/emails`,
      jsonRequest("POST", TEST_ADMIN_TOKEN, { email: alias }),
    );

    expect((await askAuthors(t, [alias])).unknown).toEqual([]);
  });

  test("a list too long to be one clone's authors is refused", async () => {
    const t = await team();

    const answer = await askAuthors(
      t,
      Array.from({ length: 201 }, (_, index) => `dev${String(index)}@example.com`),
    );

    expect(answer.status).toBe(400);
  });
});
