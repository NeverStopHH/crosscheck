/**
 * AN OPTED-OUT TEAMMATE IS STILL A COLLISION (the owner's decision on the
 * batch-2 integration review's I1). Opting out hides WHO is working, WHERE
 * (branch, topic) and WHEN (heartbeat, times); it no longer hides THAT someone
 * is working on a file the reader is about to change right now. Without it
 * Nick was told nothing while Mike, opted out, edited the same files: the
 * pilot's failure, recreated for every opted-out person.
 *
 * So the tripwire answer carries one ANONYMOUS row beside the named ones, and
 * the ghost check a time-free count of the reader's own files a hidden
 * teammate's unfinished work touches — and neither carries a single field
 * that says who, where or when.
 */
import { describe, expect, test } from "bun:test";

import { createTestDeveloper, jsonRequest, postRecords, recordEnvelope, registerTestSession, validWorkContextBody } from "./helpers.ts";
import { ROBIN_ROW } from "./live-location-walk.ts";
import { FILE, REPO, ROBIN_LIVE, leaksIn, seedOptedOutWorld, url } from "./opted-out-world.ts";
import type { OptedOutWorld } from "./opted-out-world.ts";
import { setPresenceOptOutViaApi } from "./ui-helpers.ts";

/** Past the presence window from the seed's read: her live session has gone quiet. */
const QUIET_S = 120;
/** Eight days: past the activity window a named overlap row keeps (GHOST_ACTIVE_WINDOW_DAYS, 7). */
const LONG_AFTER_S = 8 * 86_400;

interface TripwireAnswer {
  readonly sessions: readonly { readonly developerId: string }[];
  readonly anonymous?: readonly Record<string, unknown>[];
}

const ask = async (world: OptedOutWorld, who: "nick" | "robin", value: string = FILE): Promise<{ readonly body: string; readonly data: TripwireAnswer }> => {
  const key = who === "nick" ? world.nick.apiKey : world.robin.apiKey;
  const response = await world.harness.app.request(url("/api/hints/tripwire", { repo: REPO, value }), jsonRequest("GET", key));
  const body = await response.text();
  return { body, data: (JSON.parse(body) as { data: TripwireAnswer }).data };
};

/** Nothing of hers: no row, no id, no name, no location, no instant. */
const identifying = (world: OptedOutWorld, body: string): readonly string[] => [
  ...(ROBIN_ROW.test(body) ? ["a row of hers"] : []),
  ...(body.includes(world.robin.developerId) ? ["her developer id"] : []),
  ...leaksIn(body, world.harness.clock.now()),
];

describe("the tripwire about a file an opted-out teammate is working on now", () => {
  test("says a teammate is on it, as one anonymous row, and nothing of who, where or when", async () => {
    const world = await seedOptedOutWorld();

    const answer = await ask(world, "nick");

    expect(answer.data.sessions.map((row) => row.developerId)).not.toContain(world.robin.developerId);
    expect(answer.data.anonymous).toEqual([{ anonymous: true }]);
    expect(identifying(world, answer.body)).toEqual([]);
  });

  test("says nothing once she has gone quiet past the presence window", async () => {
    const world = await seedOptedOutWorld();
    world.harness.clock.advanceSeconds(QUIET_S);

    expect((await ask(world, "nick")).data.anonymous).toEqual([]);
  });

  test("is one row for two opted-out teammates, so a count singles nobody out", async () => {
    const world = await seedOptedOutWorld();
    const sam = await createTestDeveloper(world.harness, "Sam", "sam@example.com");
    const session = "cc_88888888-9999-4aaa-8bbb-cccccccccccc";
    await registerTestSession(world.harness, sam.apiKey, { id: session });
    await setPresenceOptOutViaApi(world.harness, sam.apiKey, true);
    const posted = await postRecords(world.harness, sam, {
      records: [
        recordEnvelope("work_context", validWorkContextBody({ id: "wc_sam", sessionId: session, title: "Sam's work" }), { sessionId: session }),
        recordEnvelope("target", { workContextId: "wc_sam", kind: "file", value: FILE }, { sessionId: session }),
      ],
    });
    expect(posted.data?.accepted).toBe(2);

    const answer = await ask(world, "nick");

    expect(answer.data.anonymous).toEqual([{ anonymous: true }]);
    expect(answer.body).not.toContain("Sam");
  });

  test("raises nothing about a teammate the reader muted", async () => {
    const world = await seedOptedOutWorld();
    const muted = await world.harness.app.request("/api/settings/mutes", jsonRequest("POST", world.nick.apiKey, { developer: "robin@example.com" }));
    expect(muted.status).toBe(200);

    expect((await ask(world, "nick")).data.anonymous).toEqual([]);
  });

  test("names a teammate who has not opted out, and never counts them again as anonymous", async () => {
    const world = await seedOptedOutWorld();
    await setPresenceOptOutViaApi(world.harness, world.robin.apiKey, false);

    const answer = await ask(world, "nick");
    const ghost = await world.harness.app.request(url("/api/ghost-checks", { repo: REPO }), jsonRequest("GET", world.nick.apiKey));
    const overlap = (JSON.parse(await ghost.text()) as { data: { anonymousOverlap?: unknown } }).data.anonymousOverlap;

    expect(answer.data.sessions.map((row) => row.developerId)).toContain(world.robin.developerId);
    expect(answer.data.anonymous).toEqual([]);
    expect(overlap).toBeNull();
  });

  test("never tells her about herself", async () => {
    const world = await seedOptedOutWorld();

    expect((await ask(world, "robin")).data.anonymous).toEqual([]);
  });
});

describe("the ghost check beside an opted-out teammate's unfinished work", () => {
  test("counts the reader's own files it touches, time-free and nameless", async () => {
    const world = await seedOptedOutWorld();

    const response = await world.harness.app.request(url("/api/ghost-checks", { repo: REPO }), jsonRequest("GET", world.nick.apiKey));
    const body = await response.text();
    const data = (JSON.parse(body) as { data: { ghostChecks: readonly { developerId: string }[]; anonymousOverlap?: unknown } }).data;

    expect(data.ghostChecks.map((row) => row.developerId)).not.toContain(world.robin.developerId);
    expect(data.anonymousOverlap).toEqual({ sharedFileCount: 1 });
    expect(identifying(world, body)).toEqual([]);
  });

  test("counts her unfinished work however long ago she touched it: her work's times are never read", async () => {
    // Arrange: eight days on — past the window a NAMED row keeps — her
    // session still open and beating, the work on the file untouched since
    // the seed, and Nick starting fresh on the same file.
    const world = await seedOptedOutWorld();
    world.harness.clock.advanceSeconds(LONG_AFTER_S);
    const beat = await world.harness.app.request(`/api/sessions/${ROBIN_LIVE}/heartbeat`, jsonRequest("POST", world.robin.apiKey, { status: "implementing" }));
    expect(beat.status).toBe(200);
    const session = "cc_99999999-aaaa-4bbb-8ccc-dddddddddddd";
    await registerTestSession(world.harness, world.nick.apiKey, { id: session });
    const posted = await postRecords(world.harness, world.nick, {
      records: [
        recordEnvelope(
          "work_context",
          validWorkContextBody({ id: "wc_nick_fresh", sessionId: session, title: "Nick, eight days on", createdAt: world.harness.clock.now().toISOString() }),
          { sessionId: session },
        ),
        recordEnvelope("target", { workContextId: "wc_nick_fresh", kind: "file", value: FILE }, { sessionId: session }),
      ],
    });
    expect(posted.data?.accepted).toBe(2);

    // Act
    const response = await world.harness.app.request(url("/api/ghost-checks", { repo: REPO }), jsonRequest("GET", world.nick.apiKey));
    const data = (JSON.parse(await response.text()) as { data: { anonymousOverlap?: unknown } }).data;

    // Assert: the same count as on the day she worked — whether it shows
    // never says when that was.
    expect(data.anonymousOverlap).toEqual({ sharedFileCount: 1 });
  });
});
