/**
 * The negative controls N2–N4 and the boundary N5, as test suites for any
 * profile (release-gate/profile.ts): what must stay SILENT — overlap only in
 * generated files, work merged days before, one person against himself — and
 * what must warn but qualified and ranked (a 300-file sweep). A control is
 * never relaxed by a profile: silence is silence at every budget, under
 * parallel subagents, across a compaction and a resume, and under load.
 */
import { afterAll, beforeAll, describe, expect } from "bun:test";

import { gateTest } from "./expected.ts";
import {
  CASE_TIMEOUT_MS,
  LARGE_WORD,
  SILENT,
  SWEEP_TARGETS,
  collisionBookings,
  collisionNoise,
  isQualifiedAsLarge,
  mentions,
  overlapRows,
} from "./gate-checks.ts";
import type { OverlapRows } from "./gate-checks.ts";
import type { GateContext } from "./gate-pilot.ts";
import { gitIn } from "./git.ts";
import { agentTexts, personLines } from "./host.ts";
import { startHub } from "./hub.ts";
import type { TestHub } from "./hub.ts";
import { bookedLines } from "./observe.ts";
import { N5_SHARED_FILE, runLandedCase, runSelfCase, runSweepCase } from "./scenario-boundaries.ts";
import type { LandedWorld, SelfWorld, SweepWorld } from "./scenario-boundaries.ts";
import { GENERATED_CLASSES, runGeneratedCase } from "./scenario-generated.ts";
import type { GeneratedWorld } from "./scenario-generated.ts";
import { contextsOf, ghostRows, targetsOf } from "./team.ts";
import type { GhostRow } from "./team.ts";

type Register = (id: string, name: string, body: () => void | Promise<void>) => void;

const registerFor = (ctx: GateContext): Register => (id, name, body) => gateTest(ctx.expected, id, name, body);

/** A value `beforeAll` sets, read by the tests after it. */
const heldBy = <T>(what: string): { readonly set: (value: T) => void; readonly get: () => T } => {
  const held: { value: T | null } = { value: null };
  return {
    set: (value) => {
      held.value = value;
    },
    get: () => {
      if (held.value === null) {
        throw new Error(`${what} did not run`);
      }
      return held.value;
    },
  };
};

export const describeGenerated = (ctx: GateContext): void => {
  describe(`N2 — overlap only in lockfiles and generated code: silent [${ctx.profile.name}]`, () => {
    const world = heldBy<GeneratedWorld>("N2's scenario");
    const rows = heldBy<OverlapRows>("N2's overlap read");
    beforeAll(async () => {
      world.set(await runGeneratedCase(ctx.hub(), ctx.profile));
      ctx.cleanups.push(...world.get().cleanup);
      rows.set(await overlapRows(ctx.hub(), [world.get().mike, world.get().nick], world.get().repo.repoId));
    }, CASE_TIMEOUT_MS);
    const it = registerFor(ctx);

    it("N2.setup", "both developers' own work reached the hub, and each hand edit of a generated file asked the tripwire", async () => {
      const targets = await targetsOf(ctx.hub().db, world.get().repo.repoId);
      expect(targets.some((target) => target.developer === "Mike" && target.value === "apps/streaming/feed.ts")).toBe(true);
      expect(targets.some((target) => target.developer === "Nick" && target.value === "apps/numlabs/sync.ts")).toBe(true);
      expect([...world.get().nickEdits.keys()]).toEqual(GENERATED_CLASSES.map((entry) => entry.path));
    });

    // The lockfile, __generated__/ and linguist-generated classes: fixed by the
    // generated-target rule (feat/generated-targets; spec in release-gate/scenario-generated.ts).
    for (const entry of GENERATED_CLASSES) {
      it(`N2 ${entry.name}`, "Nick's hand edit is told nothing about Mike, and no overlap row offers the file", () => {
        const edit = world.get().nickEdits.get(entry.path) ?? [];
        expect([...agentTexts(edit), ...personLines(edit)].filter((text) => text.includes("Mike"))).toEqual([]);
        const offered = [...rows.get().ghost, ...rows.get().conference].filter((row) =>
          row.sharedTargets.some((target) => target.value === entry.path),
        );
        expect(offered).toEqual([]);
      });
    }

    // fixed by the generated-target rule (feat/generated-targets; spec in release-gate/scenario-generated.ts).
    it("N2", "the whole case is silent — no collision output, no statusline overlap, no overlap row", () => {
      const { mikeSession, nickSession, mikeStatusline, nickStatusline } = world.get();
      expect(collisionNoise([mikeSession, nickSession], ["Mike", "Nick"], [mikeStatusline, nickStatusline])).toEqual(SILENT);
      expect(rows.get().ghost).toEqual([]);
      expect(rows.get().conference).toEqual([]);
    });
  });
};

export const describeLanded = (ctx: GateContext): void => {
  describe(`N3 — Mike's work merged to main days before Nick starts: silent [${ctx.profile.name}]`, () => {
    const landedHub = heldBy<TestHub>("N3's hub");
    const world = heldBy<LandedWorld>("N3's scenario");
    const rows = heldBy<OverlapRows>("N3's overlap read");
    beforeAll(async () => {
      // Its own hub: this case moves the hub's clock, and no other case may see that.
      landedHub.set(await startHub());
      world.set(await runLandedCase(landedHub.get(), ctx.profile));
      ctx.cleanups.push(...world.get().cleanup);
      rows.set(await overlapRows(landedHub.get(), [world.get().mike, world.get().nick], world.get().repo.repoId));
    }, CASE_TIMEOUT_MS);
    afterAll(async () => {
      await landedHub.get().close();
    });
    const it = registerFor(ctx);

    it("N3.setup", "Mike's context is truly landed, his session ended, and his merged commit is in Nick's checkout", async () => {
      const contexts = await contextsOf(landedHub.get().db, world.get().repo.repoId);
      const mikes = contexts.filter((context) => context.developer === "Mike");
      expect(mikes.length).toBeGreaterThan(0);
      expect(mikes.every((context) => context.landedAt !== null), JSON.stringify(mikes.map((context) => context.landedAt))).toBe(true);
      await gitIn(world.get().nickWorktree, ["merge-base", "--is-ancestor", world.get().mikeLastCommit, "HEAD"]);
    });

    it("N3", "no collision output, briefing ghost section or statusline overlap reaches Nick", () => {
      expect(collisionNoise([world.get().nickSession], ["Mike"], [world.get().nickStatusline])).toEqual(SILENT);
    });

    it("N3.rows", "no overlap row for anybody", () => {
      expect(rows.get().ghost).toEqual([]);
      expect(rows.get().conference).toEqual([]);
    });
  });
};

export const describeSelf = (ctx: GateContext): void => {
  describe(`N4 — one person, two sessions in two worktrees, the same files: silent [${ctx.profile.name}]`, () => {
    const world = heldBy<SelfWorld>("N4's scenario");
    const rows = heldBy<OverlapRows>("N4's overlap read");
    beforeAll(async () => {
      world.set(await runSelfCase(ctx.hub(), ctx.profile));
      ctx.cleanups.push(...world.get().cleanup);
      rows.set(await overlapRows(ctx.hub(), [world.get().nick], world.get().repo.repoId));
    }, CASE_TIMEOUT_MS);
    const it = registerFor(ctx);

    it("N4.setup", "both of Nick's sessions hold the same six files on the hub", async () => {
      const targets = await targetsOf(ctx.hub().db, world.get().repo.repoId);
      const contextsPerFile = new Map<string, Set<string>>();
      for (const target of targets) {
        contextsPerFile.set(target.value, new Set([...(contextsPerFile.get(target.value) ?? []), target.workContextId]));
      }
      expect([...contextsPerFile.values()].filter((contexts) => contexts.size >= 2).length).toBe(6);
    });

    it("N4", "Nick is never warned about himself — no collision output, no statusline overlap", () => {
      expect(collisionNoise([world.get().first, world.get().second], ["Nick"], world.get().statuslines)).toEqual(SILENT);
    });

    it("N4.rows", "no overlap row", () => {
      expect(rows.get().ghost).toEqual([]);
      expect(rows.get().conference).toEqual([]);
    });
  });
};

/** The hub's tripwire answer to Nick's edit of the shared file, rows in the hub's order. */
const sharedAnswer = (hub: TestHub, world: SweepWorld): readonly Readonly<Record<string, unknown>>[] => {
  const entry = hub.wire.find(
    (candidate) =>
      candidate.developer === "Nick" &&
      candidate.path.startsWith("/api/hints/tripwire") &&
      candidate.path.includes(encodeURIComponent(world.repo.repoId)) &&
      candidate.path.includes(encodeURIComponent(N5_SHARED_FILE)),
  );
  return entry === undefined
    ? []
    : (JSON.parse(entry.responseBody) as { data: { sessions: readonly Readonly<Record<string, unknown>>[] } }).data.sessions;
};

export const describeSweep = (ctx: GateContext): void => {
  describe(`N5 — a 300-file formatting sweep sharing one file: warns, qualified, ranked below the focused overlap [${ctx.profile.name}]`, () => {
    const world = heldBy<SweepWorld>("N5's scenario");
    const nickGhost = heldBy<readonly GhostRow[]>("N5's ghost read");
    beforeAll(async () => {
      world.set(await runSweepCase(ctx.hub(), ctx.profile));
      ctx.cleanups.push(...world.get().cleanup);
      nickGhost.set(await ghostRows(ctx.hub(), world.get().nick, world.get().repo.repoId));
    }, CASE_TIMEOUT_MS);
    const it = registerFor(ctx);
    const nickLines = (): readonly string[] => personLines(world.get().nickSharedEdit);

    it("N5.setup.sweep", "Mike's formatter run reached the hub as a sweep (over 50 files), the shared file among them", async () => {
      const targets = await targetsOf(ctx.hub().db, world.get().repo.repoId);
      expect(world.get().mikeTargetCount).toBeGreaterThan(SWEEP_TARGETS);
      expect(targets.some((target) => target.developer === "Mike" && target.value === N5_SHARED_FILE)).toBe(true);
    });

    it("N5.setup.focused", "the focused overlap with Tina is a ghost row for Nick (positive control)", () => {
      expect(nickGhost.get().some((row) => row.developerName === "Tina")).toBe(true);
    });

    it("N5.1", "the hub offers the sweep as an overlap on the shared file — it is not ignored", () => {
      const names = sharedAnswer(ctx.hub(), world.get()).map((row) => row["developerName"]);
      expect(names).toContain("Mike");
      expect(names).toContain("Tina");
    });

    // fixed by feat/collision-visible. The loaded lane also accepts a line Nick's connector booked that says why.
    it("N5.2", "Nick is shown the overlap with Mike in a line he reads", async () => {
      const told = mentions(nickLines(), "Mike");
      const booked = ctx.profile.mayBookInsteadOfWarn && collisionBookings(await bookedLines(world.get().nick)).length > 0;
      expect(told || booked, JSON.stringify(nickLines())).toBe(true);
    });

    // Was a gap: the tripwire row carries the size since 86bf1e98 (server hints.ts listTargetSessions).
    it("N5.3", "the overlap with Mike is qualified as a large change, in the row or the line", () => {
      const mikeRow = sharedAnswer(ctx.hub(), world.get()).find((row) => row["developerName"] === "Mike") ?? {};
      const mikeLines = nickLines().filter((line) => line.includes("Mike"));
      expect(isQualifiedAsLarge(mikeRow) || mikeLines.some((line) => LARGE_WORD.test(line) || /\b\d{3,} files\b/.test(line))).toBe(true);
    });

    // Was a gap: fixed on the batch by 86bf1e98 — a large change ranks after the focused rows here too.
    it("N5.4", "the sweep ranks below Tina's focused overlap, though Mike's heartbeat is fresher", () => {
      const order = sharedAnswer(ctx.hub(), world.get()).map((row) => row["developerName"]);
      expect(order.indexOf("Tina")).toBeLessThan(order.indexOf("Mike"));
      const text = nickLines().join("\n");
      expect(text.indexOf("Tina")).toBeGreaterThanOrEqual(0);
      expect(text.indexOf("Tina")).toBeLessThan(text.indexOf("Mike"));
    });
  });
};
