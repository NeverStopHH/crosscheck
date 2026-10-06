/**
 * THE SPOOL, SIMULATED (review-2 round 7): a seeded, deterministic model-based
 * test over the REAL register, flush, heal and SessionEnd code, against the
 * real hub on an in-memory PGlite behind a fault-injecting proxy.
 *
 * Seven rounds of review found interaction bugs one probe at a time: a fix for
 * one shape of loss opened another that only a second conversation, a crash
 * or a flapping hub could reach. This test generates those interleavings
 * mechanically. Each seed is a scenario of one to three conversations on one
 * repo spool — SessionStart and resumes up the life ladder, edits, set_intent,
 * SessionEnd, a sibling ending a live life on the hub, an hour of idleness, a
 * host that dies silently for good, an older connector's flush, hub 503s,
 * answers lost after the hub committed, refused registers, a work context the
 * hub refuses for good, and a crash before or after any hooked write. After
 * the scenario drains, the invariants I1–I6 (simulation/sim-invariants.ts)
 * must hold. A failing seed is shrunk to a minimal event trace and printed.
 *
 * Every reviewer probe is a fixed scenario below (P1–P5, p4b).
 *
 * SIM_SEEDS and SIM_SEED_BASE widen or move the sweep: `SIM_SEEDS=2000 bun test
 * test/spool-simulation.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import "./simulation/sim-hooks.ts";
import { checkInvariants } from "./simulation/sim-invariants.ts";
import type { Verdict } from "./simulation/sim-invariants.ts";
import { startSimHub } from "./simulation/sim-hub.ts";
import type { SimHub } from "./simulation/sim-hub.ts";
import { describeEvent, execute, scenarioOf } from "./simulation/sim-world.ts";
import type { Run, SimEvent } from "./simulation/sim-world.ts";
import { makeRepo } from "./helpers.ts";

const SEEDS = Number(process.env["SIM_SEEDS"] ?? "300");
const SEED_BASE = Number(process.env["SIM_SEED_BASE"] ?? "1");
/** A sweep stops at this many failing seeds: each is shrunk, and that costs runs. */
const MAX_REPORTED = 3;
/** Re-runs a shrink may spend on one failing scenario. */
const SHRINK_RUNS = 80;
/** The sweep's own bound; the measured runtime is printed with every run. */
const SWEEP_TIMEOUT_MS = 15 * 60 * 1000;
const PROBE_TIMEOUT_MS = 60 * 1000;

let hub: SimHub;
let repo: string;

beforeAll(async () => {
  hub = await startSimHub();
  repo = await makeRepo("simulation", { remote: "git@github.com:acme/simulation.git" });
});

afterAll(async () => {
  await hub.stop();
  await rm(repo, { recursive: true, force: true });
});

const verdictsOf = async (events: readonly SimEvent[]): Promise<{ readonly run: Run; readonly verdicts: readonly Verdict[] }> => {
  const run = await execute(hub, events, repo);
  return { run, verdicts: await checkInvariants(hub, run) };
};

/** Drops one event at a time while the scenario still fails, until none can go. */
const shrink = async (events: readonly SimEvent[]): Promise<readonly SimEvent[]> => {
  let current = events;
  let budget = SHRINK_RUNS;
  let changed = true;
  while (changed && budget > 0) {
    changed = false;
    for (let index = current.length - 1; index >= 0 && budget > 0; index -= 1) {
      const candidate = [...current.slice(0, index), ...current.slice(index + 1)];
      budget -= 1;
      if ((await verdictsOf(candidate)).verdicts.length > 0) {
        current = candidate;
        changed = true;
      }
    }
  }
  return current;
};

const reportOf = async (seed: number, events: readonly SimEvent[]): Promise<string> => {
  const minimal = await shrink(events);
  const { run, verdicts } = await verdictsOf(minimal);
  return [
    `seed ${String(seed)}: ${String(events.length)} events, shrunk to ${String(minimal.length)}`,
    `  events: ${minimal.map(describeEvent).join(" · ")}`,
    ...verdicts.map((verdict) => `  ${verdict.invariant}: ${verdict.detail}`),
    "  trace:",
    ...run.trace.map((line) => `    ${line}`),
  ].join("\n");
};

const said = (verdicts: readonly Verdict[]): readonly string[] =>
  verdicts.map((verdict) => `${verdict.invariant}: ${verdict.detail}`);

describe("the spool, simulated", () => {
  test(
    `${String(SEEDS)} seeded scenarios keep I1–I6`,
    async () => {
      const started = Date.now();
      const failures: string[] = [];
      for (let seed = SEED_BASE; seed < SEED_BASE + SEEDS && failures.length < MAX_REPORTED; seed += 1) {
        const events = scenarioOf(seed);
        if ((await verdictsOf(events)).verdicts.length > 0) {
          failures.push(await reportOf(seed, events));
        }
      }
      console.log(`[spool-simulation] ${String(SEEDS)} seeds from ${String(SEED_BASE)} in ${String(Date.now() - started)} ms`);
      expect(failures.join("\n\n")).toBe("");
    },
    SWEEP_TIMEOUT_MS,
  );
});

const start = (c: number): SimEvent => ({ kind: "start", c });
const edit = (c: number): SimEvent => ({ kind: "edit", c });
const end = (c: number): SimEvent => ({ kind: "end", c });
const hubEnd = (c: number): SimEvent => ({ kind: "hubEnd", c });
const fault = (kind: "records503" | "recordsLate" | "registersDown", count: number, after: number): SimEvent => ({
  kind: "fault",
  fault: kind,
  count,
  after,
});

interface Probe {
  readonly name: string;
  readonly events: readonly SimEvent[];
  /** What the probe must show beyond I1–I6, or nothing. */
  readonly shows?: (run: Run) => boolean;
}

/** Every reviewer probe, replayed by the same runner against the same invariants. */
const PROBES: readonly Probe[] = [
  {
    name: "P1/M3: a debt the hub refuses for good is bounded, and pins no drain",
    events: [
      start(0),
      start(1),
      edit(1),
      start(2),
      fault("records503", 2, 0),
      edit(2),
      end(2),
      { kind: "refuseWc", c: 0 },
      hubEnd(0),
      edit(0),
      edit(0),
      edit(0),
      edit(0),
      edit(0),
      edit(1),
    ],
    shows: (run) => run.drops.some((drop) => (drop.causes["owed_wc_refused"] ?? 0) > 0),
  },
  {
    name: "P2/M1: paying a debt never reverts the status set_intent set",
    events: [start(0), edit(0), hubEnd(0), edit(0), { kind: "intent", c: 0, status: "blocked" }, edit(0)],
    shows: (run) => run.latestStatus.size > 0,
  },
  {
    name: "P3/M2: an hour of silence hands a live life's records to nobody else",
    events: [
      fault("registersDown", 2, 0),
      start(0),
      edit(0),
      edit(0),
      start(1),
      { kind: "idle", c: 0 },
      edit(1),
      edit(0),
      edit(0),
    ],
  },
  {
    name: "P4/H1: a healing flusher never touches another conversation's owed life",
    events: [
      start(1),
      edit(1),
      start(0),
      edit(0),
      hubEnd(0),
      edit(0),
      fault("records503", 3, 0),
      edit(0),
      edit(0),
      edit(0),
      hubEnd(1),
      edit(1),
    ],
  },
  {
    name: "p4b: the moved life's re-send flaps, and the other conversation still waits for its own",
    events: [
      start(1),
      edit(1),
      start(0),
      edit(0),
      hubEnd(0),
      fault("records503", 1, 1),
      edit(0),
      fault("records503", 3, 0),
      edit(0),
      edit(0),
      edit(0),
      hubEnd(1),
      edit(1),
    ],
  },
  {
    name: "P5/L5: an older connector's flush spends an owed life's records, and every one is counted",
    events: [
      start(0),
      edit(0),
      hubEnd(0),
      fault("records503", 1, 1),
      edit(0),
      fault("records503", 1, 0),
      edit(0),
      start(1),
      { kind: "oldFlush", c: 1 },
    ],
    shows: (run) => run.drops.some((drop) => (drop.causes["author_unknown"] ?? 0) > 0),
  },
];

const crash = (at: number, when: "before" | "after"): SimEvent => ({ kind: "crash", at, when });
const intent = (c: number, status: string): SimEvent => ({ kind: "intent", c, status });

/**
 * WHAT THE SWEEP FOUND while it was being written, shrunk, kept as fixed
 * scenarios: each named by the seed that first failed and the invariant it
 * broke, every one a bug fixed in this round — or, where marked, a residual
 * the invariants allow for and loss-accounting §4.3 documents.
 */
const FOUND: readonly Probe[] = [
  { name: "seed 8 (I2): a SessionStart whose ladder climbed past an ended life left its records to be filed into it", events: [start(0), hubEnd(0), fault("records503", 2, 0), edit(0), start(0)] },
  { name: "seed 10 (I4): a SessionStart re-fire put back the status set_intent had set", events: [start(0), intent(0, "done"), start(0)] },
  { name: "seed 10, shrunk with a crash (I4): set_intent killed after the hub took its post, before its state write", events: [start(0), crash(1, "before"), intent(0, "done"), start(0)] },
  { name: "seed 46 (I1): a crash right after an append, on a life the hub ended", events: [start(0), hubEnd(0), crash(2, "after"), edit(0)] },
  { name: "seed 99 (I1, residual): records the hub took whose answer was lost, refused on a re-send", events: [start(0), fault("recordsLate", 2, 2), edit(0), edit(0), edit(0), hubEnd(0)] },
  { name: "seed 113 (I3): a SessionStart killed between its register and its state split the session's epoch", events: [crash(3, "before"), start(0), start(0)] },
  { name: "seed 115 (I2, residual): an end only a sibling saw, and a successor delivering into it", events: [start(0), fault("records503", 2, 0), hubEnd(0), edit(0), { kind: "abandon", c: 0 }] },
  { name: "seed 349 (I4): the work context a register spooled reverted the status set_intent set first", events: [crash(6, "after"), start(0), intent(0, "implementing")] },
  { name: "seed 500 (I2): a life the hub said ended, with no heal past it, was filed into by a successor", events: [start(0), fault("registersDown", 2, 0), hubEnd(0), edit(0), edit(0), fault("recordsLate", 2, 0), end(0)] },
  { name: "seed 772 (I2): a moved life's debt was paid into it after the hub ended it", events: [start(0), fault("records503", 2, 1), hubEnd(0), edit(0), hubEnd(0)] },
  { name: "seed 1020 (I4): set_intent put the old status back after a post whose answer was lost", events: [start(0), fault("recordsLate", 1, 1), fault("records503", 1, 0), intent(0, "done"), intent(0, "done"), intent(0, "blocked")] },
  { name: "seed 1033 (I2): set_intent refused as ended told nobody, and a successor filed into the life", events: [fault("records503", 2, 0), start(1), hubEnd(1), start(2), intent(1, "blocked"), { kind: "abandon", c: 1 }] },
  { name: "seed 1161 (I1, residual): a work context the hub took unheard, then withheld", events: [fault("recordsLate", 1, 0), start(1), hubEnd(1), start(1)] },
  { name: "seed 2385 (I1): a crash armed before a host goes quiet kills the next connector step, not the host", events: [start(0), crash(2, "after"), edit(0), crash(1, "after"), { kind: "abandon", c: 0 }] },
  { name: "seed 3062 (I4): a spooled work context sent after SessionEnd reverted the status set_intent set", events: [crash(7, "after"), start(0), fault("records503", 1, 1), intent(0, "blocked"), crash(1, "after"), start(0), end(0)] },
  { name: "seed 3098 (I4): the same, with the work context the register spooled", events: [fault("records503", 1, 1), crash(6, "after"), start(0), intent(0, "done"), end(0)] },
  { name: "seed 4337 (I4): set_intent killed after writing its status into the state", events: [start(1), intent(1, "done"), crash(1, "after"), intent(1, "implementing"), start(1)] },
  { name: "seed 7019 (I2): the deferred end ended a life whose work context was still owed", events: [start(0), hubEnd(0), fault("records503", 2, 2), intent(0, "blocked"), edit(0), intent(0, "reviewing")] },
];

describe("what the sweep found, as fixed scenarios", () => {
  for (const found of FOUND) {
    test(
      found.name,
      async () => {
        const { verdicts } = await verdictsOf(found.events);
        expect(said(verdicts)).toEqual([]);
      },
      PROBE_TIMEOUT_MS,
    );
  }
});

describe("the reviewer's probes, as fixed scenarios", () => {
  for (const probe of PROBES) {
    test(
      probe.name,
      async () => {
        const { run, verdicts } = await verdictsOf(probe.events);
        expect(said(verdicts)).toEqual([]);
        expect(probe.shows?.(run) ?? true).toBe(true);
      },
      PROBE_TIMEOUT_MS,
    );
  }
});
