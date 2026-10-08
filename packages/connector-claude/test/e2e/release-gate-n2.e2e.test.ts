/**
 * THE RELEASE GATE'S N2, ported (test/release-gate-nick-mike, whose
 * release-gate-nick-mike.e2e.test.ts keeps N2 as an expected failure): two
 * people whose ONLY common ground is lockfiles and generated code must warn
 * nobody. The scenario and its harness (release-gate/) are the gate's own
 * files, byte for byte; the assertions are its N2 block, as plain tests,
 * because this branch builds the rule that block specifies
 * (connector-core capture/generated.ts, server services/generated-targets.ts).
 *
 * ONE MORE ASSERTION than the gate makes, and it is the rule's other half:
 * the generated files are KEPT as targets — labelled, never dropped — so
 * `suspect` and coverage still see who touched them.
 *
 * RUNTIME: one scenario, some sixty real hook runs against a real hub.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";

import { GHOST_SECTION_HEADER } from "@crosscheck/connector-core/briefing/ghost.ts";

import { agentTexts, personLines } from "./release-gate/host.ts";
import type { HostSession } from "./release-gate/host.ts";
import { startHub } from "./release-gate/hub.ts";
import type { TestHub } from "./release-gate/hub.ts";
import { GENERATED_CLASSES, runGeneratedCase } from "./release-gate/scenario-generated.ts";
import type { GeneratedWorld } from "./release-gate/scenario-generated.ts";
import { conferenceOverlaps, ghostRows, targetsOf } from "./release-gate/team.ts";
import type { ConferenceOverlap, GateDeveloper, GhostRow } from "./release-gate/team.ts";

/** A whole case — dozens of real hook runs against a real hub — per beforeAll. */
const CASE_TIMEOUT_MS = 300_000;

/**
 * The classes the connector's denylist does NOT drop — the ones that reach the
 * hub as targets and that only the generated-target rule keeps out of overlap.
 */
const REACH_THE_HUB = [
  "apps/practice/package-lock.json",
  "packages/api/src/__generated__/schema.ts",
  "packages/proto/src/messages_pb.ts",
];

let hub: TestHub;
const cleanups: string[] = [];

beforeAll(async () => {
  hub = await startHub();
});

afterAll(async () => {
  await hub.close();
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * SILENT, as the negative controls mean it: no line a person is shown names a
 * teammate, no tripwire output (ask or notice, any thread) names one, no
 * briefing carries a ghost section, no statusline shows an overlap. The hub's
 * own overlap rows are checked beside this.
 */
const collisionNoise = (
  sessions: readonly HostSession[],
  teammates: readonly string[],
  statuslines: readonly string[],
): Readonly<Record<string, readonly string[]>> => {
  const runs = sessions.flatMap((session) => session.runs());
  const namesTeammate = (text: string): boolean => teammates.some((name) => text.includes(name));
  return {
    personLines: personLines(runs).filter(namesTeammate),
    tripwire: agentTexts(runs.filter((run) => run.event === "PreToolUse")).filter(namesTeammate),
    briefingGhosts: agentTexts(runs.filter((run) => run.event !== "PreToolUse")).filter((text) => text.includes(GHOST_SECTION_HEADER)),
    statuslines: statuslines.filter((line) => line.includes("overlap")),
  };
};

const SILENT = { personLines: [], tripwire: [], briefingGhosts: [], statuslines: [] };

interface OverlapRows {
  readonly ghost: readonly GhostRow[];
  readonly conference: readonly ConferenceOverlap[];
}

/** Every overlap row the hub would show any of `readers` on `repo`. */
const overlapRows = async (on: TestHub, readers: readonly GateDeveloper[], repo: string): Promise<OverlapRows> => ({
  ghost: (await Promise.all(readers.map(async (reader) => ghostRows(on, reader, repo)))).flat(),
  conference: (await Promise.all(readers.map(async (reader) => conferenceOverlaps(on, reader, repo)))).flat(),
});

describe("N2 — overlap only in lockfiles and generated code: silent", () => {
  let world: GeneratedWorld;
  let rows: OverlapRows;

  beforeAll(async () => {
    world = await runGeneratedCase(hub);
    cleanups.push(...world.cleanup);
    rows = await overlapRows(hub, [world.mike, world.nick], world.repo.repoId);
  }, CASE_TIMEOUT_MS);

  test("setup: both developers' own work reached the hub, and each hand edit of a generated file asked the tripwire", async () => {
    const targets = await targetsOf(hub.db, world.repo.repoId);
    expect(targets.some((target) => target.developer === "Mike" && target.value === "apps/streaming/feed.ts")).toBe(true);
    expect(targets.some((target) => target.developer === "Nick" && target.value === "apps/numlabs/sync.ts")).toBe(true);
    expect([...world.nickEdits.keys()]).toEqual(GENERATED_CLASSES.map((entry) => entry.path));
  });

  for (const entry of GENERATED_CLASSES) {
    test(`N2 ${entry.name}: Nick's hand edit is told nothing about Mike, and no overlap row offers the file`, () => {
      const edit = world.nickEdits.get(entry.path) ?? [];
      expect([...agentTexts(edit), ...personLines(edit)].filter((text) => text.includes("Mike"))).toEqual([]);
      const offered = [...rows.ghost, ...rows.conference].filter((row) =>
        row.sharedTargets.some((target) => target.value === entry.path),
      );
      expect(offered).toEqual([]);
    });
  }

  test("N2: the whole case is silent — no collision output, no statusline overlap, no overlap row", () => {
    expect(
      collisionNoise([world.mikeSession, world.nickSession], ["Mike", "Nick"], [world.mikeStatusline, world.nickStatusline]),
    ).toEqual(SILENT);
    expect(rows.ghost).toEqual([]);
    expect(rows.conference).toEqual([]);
  });

  test("N2: the generated files the denylist lets through are KEPT as both people's targets, labelled", async () => {
    // Act: what the hub holds for them — the touches `suspect` reads.
    const held = await hub.db.execute(sql`
      select d.name as developer, t.value, t.generated
        from work_context_targets t
        join work_contexts wc on wc.id = t.work_context_id
        join agent_sessions s on s.id = wc.session_id
        join developers d on d.id = s.developer_id
       where s.repo = ${world.repo.repoId} and t.generated is not null
       order by t.value, d.name`);

    // Assert: each reached the hub from BOTH sides, and none of them unlabelled.
    const labelled = held.rows.map((row) => `${String(row["developer"])} ${String(row["value"])} ${String(row["generated"])}`);
    for (const path of REACH_THE_HUB) {
      expect(labelled.filter((line) => line.includes(` ${path} `))).toHaveLength(2);
    }
  });
});
