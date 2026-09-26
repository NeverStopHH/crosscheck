/**
 * THE AUTHOR'S NOTICE (docs/1.0/landed-changes.md, step 4, decisions 8–11).
 *
 * Nick's edit stops at Mike's landed change. The why answer already names
 * who the stop tells (`told`); the stop's record then reaches the hub, and
 * Mike is told once — in his next briefing or on his next prompt, whichever
 * comes first — and never after seven days.
 *
 * Pinned here: who is told (only whom the stop named, checked against the
 * commit's address; never the reader about their own commit), once per
 * reader, file and commit; the seven days; a delivery marks only its
 * sender's notices; the author's mute hides the reader, the reader's
 * presence opt-out does not (decision 9); another repo sees nothing.
 */
import { describe, expect, test } from "bun:test";

import {
  TEST_START_ISO,
  VALID_SESSION_BODY,
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = VALID_SESSION_BODY.repo;
const FILE = "src/lines.ts";
const MIKE_EMAIL = "mike@example.com";
const KEN_EMAIL = "ken@example.com";
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const DAY_S = 86_400;
const HOUR_S = 3600;

interface Team {
  readonly harness: TestHarness;
  readonly nick: TestDeveloper;
  readonly mike: TestDeveloper;
  readonly ken: TestDeveloper;
}

/** Nick (the reader) and Mike and Ken (authors), each with a session. */
const team = async (): Promise<Team> => {
  const harness = await createTestHarness();
  const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
  const mike = await createTestDeveloper(harness, "Mike", MIKE_EMAIL);
  const ken = await createTestDeveloper(harness, "Ken", KEN_EMAIL);
  for (const [developer, id] of [
    [nick, "ses_nick"],
    [mike, "ses_mike"],
    [ken, "ses_ken"],
  ] as const) {
    expect((await registerTestSession(harness, developer.apiKey, { id })).status).toBe(200);
  }
  return { harness, nick, mike, ken };
};

interface StopCommit {
  readonly sha?: string;
  readonly subject?: string;
  readonly authorEmail?: string;
  readonly author: TestDeveloper;
  readonly missing?: boolean;
}

const stopBody = (
  t: Team,
  commits: readonly StopCommit[],
  overrides: { readonly path?: string; readonly repo?: string; readonly sessionId?: string; readonly stoppedAt?: string } = {},
) => ({
  sessionId: overrides.sessionId ?? "ses_nick",
  repo: overrides.repo ?? REPO,
  path: overrides.path ?? FILE,
  stoppedAt: overrides.stoppedAt ?? t.harness.clock.now().toISOString(),
  commits: commits.map((commit) => ({
    sha: commit.sha ?? SHA,
    subject: commit.subject ?? "Fix line offset",
    authorEmail: commit.authorEmail ?? MIKE_EMAIL,
    authorDeveloperId: commit.author.developerId,
    missing: commit.missing ?? true,
  })),
});

/** Nick's connector flushing the stop's record. */
const nickStops = async (
  t: Team,
  commits: readonly StopCommit[],
  overrides: Parameters<typeof stopBody>[2] = {},
  reader: TestDeveloper = t.nick,
): Promise<{ status: number; accepted: number; rejected: number }> => {
  const body = stopBody(t, commits, overrides);
  const posted = await postRecords(t.harness, reader, {
    records: [recordEnvelope("landed_stop", body, { sessionId: body.sessionId, ts: t.harness.clock.now().toISOString() })],
  });
  return { status: posted.status, accepted: posted.data?.accepted ?? 0, rejected: posted.data?.rejected ?? 0 };
};

interface NoticeCommitView {
  readonly id: string;
  readonly sha: string;
  readonly subject: string;
  readonly missing: boolean;
}

interface NoticeView {
  readonly id: string;
  readonly readerName: string;
  readonly path: string;
  readonly stoppedAt: string;
  readonly commits: readonly NoticeCommitView[];
}

const noticesFor = async (t: Team, author: TestDeveloper, repo: string = REPO): Promise<readonly NoticeView[]> => {
  const response = await t.harness.app.request(
    `/api/landed/notices?repo=${encodeURIComponent(repo)}`,
    jsonRequest("GET", author.apiKey),
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: { notices: NoticeView[] } }).data.notices;
};

const delivered = async (
  t: Team,
  author: TestDeveloper,
  noticeIds: readonly string[],
  sessionId: string,
): Promise<number> => {
  const posted = await postRecords(t.harness, author, {
    records: [
      recordEnvelope(
        "landed_notice_delivery",
        { sessionId, noticeIds, deliveredAt: t.harness.clock.now().toISOString() },
        { sessionId },
      ),
    ],
  });
  expect(posted.status).toBe(200);
  return posted.data?.accepted ?? 0;
};

const commitIds = (notices: readonly NoticeView[]): readonly string[] =>
  notices.flatMap((notice) => notice.commits.map((commit) => commit.id));

describe("POST /api/landed/context: who the stop tells", () => {
  test("names the developer each named commit's address belongs to, never the caller, never an address", async () => {
    const t = await team();

    const response = await t.harness.app.request(
      "/api/landed/context",
      jsonRequest("POST", t.nick.apiKey, {
        repo: REPO,
        path: FILE,
        commits: [
          { sha: SHA, authorEmail: MIKE_EMAIL, committedAt: TEST_START_ISO },
          { sha: OTHER_SHA, authorEmail: "stranger@example.com", committedAt: TEST_START_ISO },
          { sha: "c".repeat(40), authorEmail: "nick@example.com", committedAt: TEST_START_ISO },
        ],
      }),
    );
    const raw = await response.text();

    expect(response.status).toBe(200);
    const told = (JSON.parse(raw) as { data: { told: unknown[] } }).data.told;
    expect(told).toEqual([{ sha: SHA, developerId: t.mike.developerId, name: "Mike" }]);
    expect(raw).not.toContain("@example.com");
  });

  test("a teammate who muted the reader is still named: a mute is never disclosed", async () => {
    const t = await team();
    const muted = await t.harness.app.request(
      "/api/settings/mutes",
      jsonRequest("POST", t.mike.apiKey, { developer: t.nick.developerId }),
    );
    expect(muted.status).toBe(200);

    const response = await t.harness.app.request(
      "/api/landed/context",
      jsonRequest("POST", t.nick.apiKey, {
        repo: REPO,
        path: FILE,
        commits: [{ sha: SHA, authorEmail: MIKE_EMAIL, committedAt: TEST_START_ISO }],
      }),
    );

    const told = ((await response.json()) as { data: { told: { name: string }[] } }).data.told;
    expect(told.map((entry) => entry.name)).toEqual(["Mike"]);
  });
});

describe("the author's notice", () => {
  test("a stop at Mike's change is told to Mike, grouped by reader and file", async () => {
    const t = await team();

    const stop = await nickStops(t, [
      { author: t.mike, subject: "Fix line offset" },
      { author: t.mike, sha: OTHER_SHA, subject: "Count from one", missing: false },
    ]);
    const notices = await noticesFor(t, t.mike);

    expect(stop).toEqual({ status: 200, accepted: 1, rejected: 0 });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ readerName: "Nick", path: FILE, stoppedAt: TEST_START_ISO });
    expect(notices[0]?.commits.map((commit) => [commit.sha, commit.subject, commit.missing])).toEqual([
      [SHA, "Fix line offset", true],
      [OTHER_SHA, "Count from one", false],
    ]);
  });

  test("once delivered, it is not listed again, and a later stop on the same commit adds nothing", async () => {
    const t = await team();
    await nickStops(t, [{ author: t.mike }]);
    const first = await noticesFor(t, t.mike);

    expect(await delivered(t, t.mike, commitIds(first), "ses_mike")).toBe(1);
    await registerTestSession(t.harness, t.nick.apiKey, { id: "ses_nick_2" });
    await nickStops(t, [{ author: t.mike }], { sessionId: "ses_nick_2" });

    expect(await noticesFor(t, t.mike)).toEqual([]);
  });

  test("a later stop on a commit not yet told refreshes it: the reader has it now", async () => {
    const t = await team();
    await nickStops(t, [{ author: t.mike, missing: true }]);
    t.harness.clock.advanceSeconds(HOUR_S);
    await registerTestSession(t.harness, t.nick.apiKey, { id: "ses_nick_2" });

    await nickStops(t, [{ author: t.mike, missing: false }], { sessionId: "ses_nick_2" });
    const notices = await noticesFor(t, t.mike);

    expect(notices).toHaveLength(1);
    expect(notices[0]?.commits.map((commit) => commit.missing)).toEqual([false]);
    expect(notices[0]?.stoppedAt).toBe(t.harness.clock.now().toISOString());
  });

  test("a new commit on the same file after a delivery is told on its own", async () => {
    const t = await team();
    await nickStops(t, [{ author: t.mike }]);
    await delivered(t, t.mike, commitIds(await noticesFor(t, t.mike)), "ses_mike");
    await registerTestSession(t.harness, t.nick.apiKey, { id: "ses_nick_2" });

    await nickStops(t, [{ author: t.mike }, { author: t.mike, sha: OTHER_SHA }], { sessionId: "ses_nick_2" });
    const notices = await noticesFor(t, t.mike);

    expect(notices.flatMap((notice) => notice.commits.map((commit) => commit.sha))).toEqual([OTHER_SHA]);
  });

  test("only the developer the stop named is told, and only if the address is theirs", async () => {
    const t = await team();

    // Named Ken for Mike's address: neither is told.
    await nickStops(t, [{ author: t.ken, authorEmail: MIKE_EMAIL }]);

    expect(await noticesFor(t, t.mike)).toEqual([]);
    expect(await noticesFor(t, t.ken)).toEqual([]);
  });

  test("a reader is never told about their own commit", async () => {
    const t = await team();

    await nickStops(t, [{ author: t.nick, authorEmail: "nick@example.com" }]);

    expect(await noticesFor(t, t.nick)).toEqual([]);
  });

  test("each author hears only their own commits of one stop", async () => {
    const t = await team();

    await nickStops(t, [{ author: t.mike }, { author: t.ken, sha: OTHER_SHA, authorEmail: KEN_EMAIL }]);

    expect((await noticesFor(t, t.mike)).flatMap((n) => n.commits.map((c) => c.sha))).toEqual([SHA]);
    expect((await noticesFor(t, t.ken)).flatMap((n) => n.commits.map((c) => c.sha))).toEqual([OTHER_SHA]);
  });

  test("a stop in another session of somebody else is refused", async () => {
    const t = await team();

    const stop = await nickStops(t, [{ author: t.mike }], { sessionId: "ses_ken" });

    expect(stop.rejected).toBe(1);
    expect(await noticesFor(t, t.mike)).toEqual([]);
  });

  test("a notice waits seven days, and not a moment longer", async () => {
    const t = await team();
    await nickStops(t, [{ author: t.mike }]);

    t.harness.clock.advanceSeconds(7 * DAY_S - 1);
    expect(await noticesFor(t, t.mike)).toHaveLength(1);
    t.harness.clock.advanceSeconds(2);
    expect(await noticesFor(t, t.mike)).toEqual([]);
  });

  test("a stop more than seven days old when it reaches the hub is not told", async () => {
    const t = await team();
    t.harness.clock.advanceSeconds(8 * DAY_S);
    await registerTestSession(t.harness, t.nick.apiKey, { id: "ses_nick_late" });

    await nickStops(t, [{ author: t.mike }], { sessionId: "ses_nick_late", stoppedAt: TEST_START_ISO });

    expect(await noticesFor(t, t.mike)).toEqual([]);
  });

  test("a stop dated in the future is dated now", async () => {
    const t = await team();

    await nickStops(t, [{ author: t.mike }], { stoppedAt: "2099-01-01T00:00:00.000Z" });

    expect((await noticesFor(t, t.mike))[0]?.stoppedAt).toBe(TEST_START_ISO);
  });

  test("an expired notice frees its commit: a stop after the seven days is told again", async () => {
    const t = await team();
    await nickStops(t, [{ author: t.mike }]);
    await delivered(t, t.mike, commitIds(await noticesFor(t, t.mike)), "ses_mike");
    t.harness.clock.advanceSeconds(8 * DAY_S);
    await registerTestSession(t.harness, t.nick.apiKey, { id: "ses_nick_later" });

    await nickStops(t, [{ author: t.mike }], { sessionId: "ses_nick_later" });

    expect(await noticesFor(t, t.mike)).toHaveLength(1);
  });

  test("a reader still stopped a week after being told tells the author again, counted from the first stop", async () => {
    const t = await team();
    await nickStops(t, [{ author: t.mike }]);
    await delivered(t, t.mike, commitIds(await noticesFor(t, t.mike)), "ses_mike");
    t.harness.clock.advanceSeconds(4 * DAY_S);
    await registerTestSession(t.harness, t.nick.apiKey, { id: "ses_nick_day4" });
    await nickStops(t, [{ author: t.mike }], { sessionId: "ses_nick_day4" });
    expect(await noticesFor(t, t.mike)).toEqual([]);

    t.harness.clock.advanceSeconds(4 * DAY_S);
    await registerTestSession(t.harness, t.nick.apiKey, { id: "ses_nick_day8" });
    await nickStops(t, [{ author: t.mike }], { sessionId: "ses_nick_day8" });

    expect(await noticesFor(t, t.mike)).toHaveLength(1);
  });

  test("a replayed older stop does not roll a newer one back", async () => {
    const t = await team();
    const first = t.harness.clock.now().toISOString();
    t.harness.clock.advanceSeconds(HOUR_S);
    await nickStops(t, [{ author: t.mike, missing: false }]);

    await nickStops(t, [{ author: t.mike, missing: true }], { stoppedAt: first });
    const notices = await noticesFor(t, t.mike);

    expect(notices[0]?.commits.map((commit) => commit.missing)).toEqual([false]);
    expect(notices[0]?.stoppedAt).toBe(t.harness.clock.now().toISOString());
  });

  test("a stop naming one commit twice is one notice, and the batch beside it still lands", async () => {
    const t = await team();

    const stop = await nickStops(t, [{ author: t.mike }, { author: t.mike }]);

    expect(stop).toEqual({ status: 200, accepted: 1, rejected: 0 });
    expect((await noticesFor(t, t.mike)).flatMap((n) => n.commits.map((c) => c.sha))).toEqual([SHA]);
  });

  test("a delivery marks only notices addressed to its sender", async () => {
    const t = await team();
    await nickStops(t, [{ author: t.mike }]);
    const ids = commitIds(await noticesFor(t, t.mike));

    expect(await delivered(t, t.ken, ids, "ses_ken")).toBe(0);
    expect(await noticesFor(t, t.mike)).toHaveLength(1);
  });

  test("the author's mute of the reader hides the notice while it lasts", async () => {
    const t = await team();
    await nickStops(t, [{ author: t.mike }]);
    await t.harness.app.request(
      "/api/settings/mutes",
      jsonRequest("POST", t.mike.apiKey, { developer: t.nick.developerId }),
    );

    expect(await noticesFor(t, t.mike)).toEqual([]);

    await t.harness.app.request(
      `/api/settings/mutes/${encodeURIComponent(t.nick.developerId)}`,
      jsonRequest("DELETE", t.mike.apiKey),
    );
    expect(await noticesFor(t, t.mike)).toHaveLength(1);
  });

  test("the reader's presence opt-out does not hide it: their stop said so (decision 9)", async () => {
    const t = await team();
    const optOut = await t.harness.app.request(
      "/api/settings/presence",
      jsonRequest("PUT", t.nick.apiKey, { optOut: true }),
    );
    expect(optOut.status).toBe(200);

    await nickStops(t, [{ author: t.mike }]);

    expect(await noticesFor(t, t.mike)).toHaveLength(1);
  });

  test("another repo sees nothing", async () => {
    const t = await team();
    await nickStops(t, [{ author: t.mike }]);

    expect(await noticesFor(t, t.mike, "github.com/acme/other")).toEqual([]);
  });

  test("at most three groups, the newest stops first", async () => {
    const t = await team();
    for (const [index, path] of ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"].entries()) {
      t.harness.clock.advanceSeconds(60);
      await nickStops(t, [{ author: t.mike, sha: String(index + 1).repeat(40) }], { path });
    }

    const notices = await noticesFor(t, t.mike);

    expect(notices.map((notice) => notice.path)).toEqual(["src/d.ts", "src/c.ts", "src/b.ts"]);
  });

  test("the prompt hint's call carries the same notices, so live delivery costs no round trip", async () => {
    const t = await team();
    await nickStops(t, [{ author: t.mike }]);

    const response = await t.harness.app.request(
      `/api/hints/candidates?repo=${encodeURIComponent(REPO)}&query=${encodeURIComponent("line offsets")}`,
      jsonRequest("GET", t.mike.apiKey),
    );

    expect(response.status).toBe(200);
    const notices = ((await response.json()) as { data: { notices: NoticeView[] } }).data.notices;
    expect(notices.map((notice) => notice.readerName)).toEqual(["Nick"]);
  });
});
