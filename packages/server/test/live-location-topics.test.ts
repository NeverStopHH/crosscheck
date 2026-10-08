/**
 * AN OPTED-OUT DEVELOPER'S TOPICS (topic review H4).
 *
 * One session of hers edits sibling worktrees on other branches, one TOPIC
 * work context each (DESIGN.md "One session, many topics"). On a `local:`
 * repo a topic's title is its BARE branch — no ` @ <label>` to recognise —
 * and a build that sent no marker leaves the hub only the shape rule, which
 * withholds a title equal to a branch the hub knows for her. Her sessions
 * never registered on a topic's branch, so the hub must learn it from the
 * topic itself, as the topic lands (services/record-handlers.ts) and, for a
 * topic stored before that, at boot (db/bootstrap.sql).
 *
 * The full boundary is the differential walk (live-location-differential.
 * test.ts, its topic actions); this pins the four routes the review named,
 * fast: the conference, hint candidates, search and the work-context list.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { WITHHELD_TITLE } from "@crosscheck/schema";

import { jsonRequest, postRecords, recordEnvelope, validWorkContextBody } from "./helpers.ts";
import {
  CREATED_AT,
  FILE,
  LOCAL_REPO,
  ROBIN_LOCAL,
  ROBIN_LOCAL_TOPIC,
  SECRET_LOCAL_TOPIC_BRANCH,
  SECRET_TOPIC_SHA,
  seedOptedOutWorld,
} from "./opted-out-world.ts";
import type { OptedOutWorld } from "./opted-out-world.ts";

const BOOTSTRAP_SQL_URL = new URL("../src/db/bootstrap.sql", import.meta.url);

/** The PGlite client drizzle wraps (`Db` does not name it). */
interface RawClient {
  readonly $client: { readonly exec: (text: string) => Promise<unknown> };
}

/** What every start of the hub runs on its database (db/client.ts runBootstrap). */
const boot = async (world: OptedOutWorld): Promise<void> => {
  await (world.harness.db as unknown as RawClient).$client.exec(await Bun.file(BOOTSTRAP_SQL_URL).text());
};

/** The four routes, each where her local repo's work shows. */
const ROUTES: readonly string[] = [
  `/api/conference?repo=${encodeURIComponent(LOCAL_REPO)}`,
  `/api/hints/candidates?repo=${encodeURIComponent(LOCAL_REPO)}&query=${encodeURIComponent("rotation window refresh scratch topic")}`,
  `/api/search?repo=${encodeURIComponent(LOCAL_REPO)}&query=${encodeURIComponent("rotation window refresh")}`,
  `/api/work-contexts?repo=${encodeURIComponent(LOCAL_REPO)}`,
];

/** Her topic on the local repo, as a build without the marker sent it. */
const openUnmarkedLocalTopic = async (world: OptedOutWorld): Promise<void> => {
  const posted = await postRecords(world.harness, world.robin, {
    records: [
      recordEnvelope(
        "work_context",
        validWorkContextBody({
          id: ROBIN_LOCAL_TOPIC,
          sessionId: ROBIN_LOCAL,
          title: SECRET_LOCAL_TOPIC_BRANCH,
          status: "implementing",
          branch: SECRET_LOCAL_TOPIC_BRANCH,
          baseCommit: SECRET_TOPIC_SHA,
          description: "rotation window refresh scratch topic",
          createdAt: CREATED_AT,
        }),
        { sessionId: ROBIN_LOCAL },
      ),
      recordEnvelope("target", { workContextId: ROBIN_LOCAL_TOPIC, kind: "file", value: FILE }, { sessionId: ROBIN_LOCAL }),
    ],
  });
  expect(posted.data?.accepted).toBe(2);
};

/** Every route Nick reads that names her topic's branch. */
const leakingRoutes = async (world: OptedOutWorld): Promise<readonly string[]> => {
  const leaking: string[] = [];
  for (const route of ROUTES) {
    const response = await world.harness.app.request(route, jsonRequest("GET", world.nick.apiKey));
    expect(response.status).toBe(200);
    if ((await response.text()).includes(SECRET_LOCAL_TOPIC_BRANCH)) {
      leaking.push(route.split("?")[0] ?? route);
    }
  }
  return leaking;
};

const listedTitleOf = async (world: OptedOutWorld): Promise<string | undefined> => {
  const response = await world.harness.app.request(ROUTES[3] ?? "", jsonRequest("GET", world.nick.apiKey));
  const body = (await response.json()) as { data: { workContexts: readonly { id: string; title: string }[] } };
  return body.data.workContexts.find((context) => context.id === ROBIN_LOCAL_TOPIC)?.title;
};

describe("an opted-out developer's unmarked topic on a local repo", () => {
  test("is withheld on the conference, hint candidates, search and the work-context list", async () => {
    // Arrange
    const world = await seedOptedOutWorld();

    // Act
    await openUnmarkedLocalTopic(world);

    // Assert: the work shows, its branch nowhere
    expect(await leakingRoutes(world)).toEqual([]);
    expect(await listedTitleOf(world)).toBe(WITHHELD_TITLE);
  });

  test("whose branch arrives on a later copy is withheld too", async () => {
    // Arrange: a first copy without the topic fields (a set_intent of a build
    // before topics' fields reached it), then the topic's own copy
    const world = await seedOptedOutWorld();
    const first = await postRecords(world.harness, world.robin, {
      records: [
        recordEnvelope(
          "work_context",
          validWorkContextBody({ id: ROBIN_LOCAL_TOPIC, sessionId: ROBIN_LOCAL, title: SECRET_LOCAL_TOPIC_BRANCH, status: "analyzing", description: "rotation window refresh scratch topic", createdAt: CREATED_AT }),
          { sessionId: ROBIN_LOCAL },
        ),
      ],
    });
    expect(first.data?.accepted).toBe(1);

    // Act
    await openUnmarkedLocalTopic(world);

    // Assert
    expect(await leakingRoutes(world)).toEqual([]);
  });

  test("never enters the search index under its branch", async () => {
    // Arrange
    const world = await seedOptedOutWorld();

    // Act: the topic lands, and a colleague searches the one word only its branch holds
    await openUnmarkedLocalTopic(world);
    const response = await world.harness.app.request(
      `/api/search?repo=${encodeURIComponent(LOCAL_REPO)}&query=${encodeURIComponent("locarno")}`,
      jsonRequest("GET", world.nick.apiKey),
    );

    // Assert: a guessed branch finds nothing of hers (services/live-location.ts isTitleWithheldFromIndex)
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(ROBIN_LOCAL_TOPIC);
  });

  test("stored before the hub remembered topic branches, is withheld from the next boot on", async () => {
    // Arrange: the topic as an older hub stored it — its branch unknown to her list
    const world = await seedOptedOutWorld();
    await openUnmarkedLocalTopic(world);
    await world.harness.db.execute(sql`DELETE FROM developer_branches WHERE branch = ${SECRET_LOCAL_TOPIC_BRANCH}`);
    const before = await leakingRoutes(world);

    // Act
    await boot(world);

    // Assert: what leaked on the routes that judge her titles by her branches
    // (the work-context list also judges by the topic's own, merge 7285f78d)
    // leaks no longer
    expect(before).toEqual(["/api/conference", "/api/hints/candidates", "/api/search"]);
    expect(await leakingRoutes(world)).toEqual([]);
  });
});
