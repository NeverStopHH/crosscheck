/**
 * THE RELEASE GATE, I1: the pilot's collision with one of the two opted out
 * of presence (the owner's decision on the batch-2 integration review's I1).
 * A focused case on this branch, beside the gate's P1/N1–N5, on the same
 * harness (release-gate/): real hooks, a real hub over PGlite, real git.
 *
 * Mike runs `crosscheck presence off`, then he and Nick change the same three
 * files while both are live. Opting out hides WHO, WHERE and WHEN, not THAT
 * someone is on a file a teammate touches right now:
 *  - Nick is told "a teammate is working on <file> right now", as a person
 *    and as an agent, on the main thread and in a subagent; his statusline
 *    counts one teammate; his next briefing counts the files a teammate's
 *    unfinished work also touches. No collision surface he is shown, and no
 *    collision answer his connector reads off the hub, carries Mike's name,
 *    email, id, branch, session, work context or title.
 *  - Mike is still told about Nick by name: Nick never opted out.
 *
 * WHAT IT DOES NOT HIDE, pinned so it cannot grow: Mike's published work
 * context stays in the briefing's listing, attributed, with its creation age
 * (visibility.ts «creation»; the opt-out retracts no authorship). In a team
 * of two that names "a teammate" by elimination.
 *
 * RUNTIME: one scenario, some forty real hook runs against a real hub, and
 * one wait past the presence cache.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { basename } from "node:path";
import { sql } from "drizzle-orm";

import { GHOST_SECTION_HEADER } from "@crosscheck/connector-core/briefing/ghost.ts";

import { agentTexts, personLines } from "./release-gate/host.ts";
import type { HookRun } from "./release-gate/host.ts";
import { startHub } from "./release-gate/hub.ts";
import type { TestHub } from "./release-gate/hub.ts";
import { SHARED_FILES, runOptedOutCase } from "./release-gate/scenario-i1-opted-out.ts";
import type { OptedOutWorld } from "./release-gate/scenario-i1-opted-out.ts";
import { MIKE_BRANCH, TOPIC_BRANCH } from "./release-gate/scenario-long-session.ts";
import { targetsOf } from "./release-gate/team.ts";

/** One scenario — real hook runs against a real hub, and a wait past the presence cache. */
const CASE_TIMEOUT_MS = 300_000;

/** The person's line names the file; the agent's carries its repo-relative path. */
const personLiveLine = (path: string): string =>
  `crosscheck: A teammate is working on ${basename(path)} right now — talk to your team before you change it`;
const agentLiveLine = (path: string): string =>
  `crosscheck: A teammate is working on ${path} right now — talk to your team before you change it.`;

const ANONYMOUS_GHOST_LINE = "- A teammate's work in progress also touches 3 of your files";

/** The hub routes a collision is built from: the tripwire, the ghost check, presence. */
const COLLISION_ROUTE = /^\/api\/(?:hints\/tripwire|ghost-checks|presence)\b/;
/** The one route allowed to name him: the work-context listing (visibility.ts «creation»). */
const LISTING_ROUTE = /^\/api\/work-contexts\?/;
/**
 * A listing entry of his, as the briefing renders it: name, status, title —
 * and no age: his last touch is withheld, and the creation that is left said
 * when he was there (batch-2 integration review, M5).
 */
const LISTING_ENTRY = /^- Mike, status [a-z_]+: «[^»]*»$/;

let hub: TestHub;
let world: OptedOutWorld;
const cleanups: string[] = [];

beforeAll(async () => {
  hub = await startHub();
  world = await runOptedOutCase(hub);
  cleanups.push(...world.cleanup);
}, CASE_TIMEOUT_MS);

afterAll(async () => {
  await hub.close();
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

/** Everything that says it is Mike: who he is, where he works, and every row of his the hub holds. */
const mikeMarkers = async (): Promise<readonly string[]> => {
  const held = await hub.db.execute(sql`
    select s.id as session_id, wc.id as context_id, wc.title
      from agent_sessions s
      left join work_contexts wc on wc.session_id = s.id
     where s.developer_id = ${world.mike.account.developerId}`);
  const rows = held.rows.flatMap((row) => [row["session_id"], row["context_id"], row["title"]]);
  return [
    "Mike",
    world.mike.account.email,
    world.mike.account.developerId,
    MIKE_BRANCH,
    ...new Set(rows.filter((value): value is string => typeof value === "string" && value.length > 0)),
  ];
};

const carrying = (markers: readonly string[], texts: readonly string[]): readonly string[] =>
  markers.filter((marker) => texts.some((text) => text.includes(marker)));

/** A briefing's ghost section: its header and the entries under it. */
const ghostSection = (text: string): readonly string[] => {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith(GHOST_SECTION_HEADER));
  if (start === -1) {
    return [];
  }
  const after = lines.slice(start + 1);
  const end = after.findIndex((line) => !line.startsWith("- "));
  return [lines[start] ?? "", ...(end === -1 ? after : after.slice(0, end))];
};

/** What Nick is told AS A COLLISION: person lines, tripwire output, briefing ghost sections, the statusline. */
const nickCollisionTexts = (): readonly string[] => {
  const runs: readonly HookRun[] = world.nickSession.runs();
  return [
    ...personLines(runs),
    ...agentTexts(runs.filter((run) => run.event === "PreToolUse")),
    ...agentTexts(runs.filter((run) => run.event !== "PreToolUse")).flatMap(ghostSection),
    world.nickStatusline,
  ];
};

const nickWire = (): readonly { readonly path: string; readonly body: string }[] =>
  hub.wire.filter((entry) => entry.developer === "Nick").map((entry) => ({ path: entry.path, body: entry.responseBody }));

describe("I1 — Mike opted out of presence: Nick is told a teammate is on the shared files, Mike is told it is Nick", () => {
  test("setup: Mike's opt-out holds, and both people's shared files reached the hub as their targets", async () => {
    const settings = await hub.getAs<{ presenceOptOut: boolean }>(world.mike.account, "/api/settings");
    expect(settings.presenceOptOut).toBe(true);
    const targets = await targetsOf(hub.db, world.repo.repoId);
    for (const path of SHARED_FILES) {
      expect(targets.filter((target) => target.value === path).map((target) => target.developer).sort()).toEqual(["Mike", "Nick"]);
    }
  });

  test("I1.1a: Nick's first edit of a shared file tells NICK a teammate is working on it right now", () => {
    expect(personLines(world.nickFirstEdit).filter((line) => line.startsWith(personLiveLine(SHARED_FILES[0])))).toHaveLength(1);
  });

  test("I1.1b: Nick's agent is told the same sentence on that edit", () => {
    expect(agentTexts(world.nickFirstEdit).filter((text) => text.startsWith(agentLiveLine(SHARED_FILES[0])))).toHaveLength(1);
  });

  test("I1.1c: the second shared file is told to the agent again, and not to the person twice", () => {
    expect(agentTexts(world.nickSecondEdit).filter((text) => text.startsWith(agentLiveLine(SHARED_FILES[1])))).toHaveLength(1);
    expect(personLines(world.nickSecondEdit).filter((line) => line.includes("teammate"))).toEqual([]);
  });

  test("I1.1d: the subagent's edit of the third shared file is told a teammate is on it", () => {
    const subagentEdits = world.nickSubagent.filter((run) => run.agentId !== null && run.event === "PreToolUse");
    expect(agentTexts(subagentEdits).filter((text) => text.startsWith(agentLiveLine(SHARED_FILES[2])))).toHaveLength(1);
  });

  test("I1.1e: Nick's statusline counts one teammate on the three shared files, nameless", () => {
    expect(world.nickStatusline).toContain("⚠ overlap: 1 teammate · 3 files");
  });

  test("I1.1f: Nick's next briefing counts the files a teammate's unfinished work also touches, nameless and time-free", () => {
    const lines = agentTexts(world.nickResume).flatMap(ghostSection);
    expect(lines.filter((line) => line.startsWith(ANONYMOUS_GHOST_LINE))).toHaveLength(1);
  });

  test("I1.2a: no collision surface Nick is shown says it is Mike", async () => {
    expect(carrying(await mikeMarkers(), nickCollisionTexts())).toEqual([]);
  });

  test("I1.2b: no collision answer Nick's connector reads off the hub says it is Mike, and only the listing names him", async () => {
    const markers = await mikeMarkers();
    const wire = nickWire();
    const collisionAnswers = wire.filter((entry) => COLLISION_ROUTE.test(entry.path));
    const naming = wire.filter((entry) => carrying(markers, [entry.body]).length > 0);

    expect(collisionAnswers.length).toBeGreaterThan(0);
    expect(carrying(markers, collisionAnswers.map((entry) => entry.body))).toEqual([]);
    expect(naming.filter((entry) => !LISTING_ROUTE.test(entry.path)).map((entry) => entry.path)).toEqual([]);
  });

  test("I1.2c: where Nick is shown Mike at all, it is his published work context in the listing (visibility.ts «creation»)", () => {
    const runs = world.nickSession.runs();
    const naming = [...personLines(runs), ...agentTexts(runs)].flatMap((text) => text.split("\n")).filter((line) => line.includes("Mike"));
    expect(naming.filter((line) => !LISTING_ENTRY.test(line))).toEqual([]);
  });

  test("I1.2d: every tripwire answer Nick's connector read about a shared file carried exactly one nameless row", () => {
    const answers = nickWire()
      .filter((entry) => entry.path.startsWith("/api/hints/tripwire"))
      .filter((entry) => SHARED_FILES.some((path) => entry.path.includes(encodeURIComponent(path))))
      .map((entry) => (JSON.parse(entry.body) as { data: { anonymous?: unknown } }).data.anonymous);
    expect(answers.length).toBeGreaterThan(0);
    expect(answers.filter((rows) => JSON.stringify(rows) !== JSON.stringify([{ anonymous: true }]))).toEqual([]);
  });

  test("I1.3: Mike, opted out himself, is still told about Nick by name, with Nick's branch", () => {
    const named = personLines(world.mikeEditAfterNick).filter((line) =>
      line.startsWith(`crosscheck: Nick is working on ${basename(SHARED_FILES[0])} on branch ${TOPIC_BRANCH}`),
    );
    expect(named).toHaveLength(1);
    expect(world.mikeStatusline).toContain("⚠ overlap: Nick");
  });
});
