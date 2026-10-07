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
 * Round 8 adopted the round-7 review's extensions: two processes at once, a
 * slow hub, a week passing for a dead host's files — at production timing.
 * Each seed that review found failing is a fixed scenario too; one still open
 * is marked `failing` with the fix it waits for, and the sweep skips it.
 *
 * Round 9 adopted the round-8 review's: a disk that refuses writes (`io`), a
 * night the hub reaps through, a week away, a conversation woken, connector-
 * claude's state recovery and a heartbeat with its heal (`sleep`), and two
 * processes of one conversation around set_intent, SessionStart and SessionEnd
 * (`focus`). SIM_ADD picks the generator (`shipped`, `io`, `sleep`, `focus`,
 * `all`); its probes and failing seeds are fixed scenarios below.
 *
 * SIM_SEEDS and SIM_SEED_BASE widen or move the sweep: `SIM_SEEDS=2000 bun test
 * test/spool-simulation.test.ts`. Every run prints the over-count: records the
 * ledger calls lost that the hub holds.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import "./simulation/sim-hooks.ts";
import { accountingStats, checkInvariants } from "./simulation/sim-invariants.ts";
import type { Verdict } from "./simulation/sim-invariants.ts";
import { startSimHub } from "./simulation/sim-hub.ts";
import type { SimHub } from "./simulation/sim-hub.ts";
import { describeEvent, execute, GENERATORS, scenarioOf } from "./simulation/sim-world.ts";
import type { GeneratorName, Run, SimEvent } from "./simulation/sim-world.ts";
import { makeRepo } from "./helpers.ts";

const SEEDS = Number(process.env["SIM_SEEDS"] ?? "300");
const SEED_BASE = Number(process.env["SIM_SEED_BASE"] ?? "1");
const GENERATOR_NAME = process.env["SIM_ADD"] ?? "shipped";
if (!(GENERATOR_NAME in GENERATORS)) {
  throw new Error(`SIM_ADD names no generator: ${GENERATOR_NAME} (${Object.keys(GENERATORS).join(", ")})`);
}
const GENERATOR = GENERATORS[GENERATOR_NAME as GeneratorName];
/** A sweep stops at this many failing seeds: each is shrunk, and that costs runs. */
const MAX_REPORTED = 3;
/** Re-runs a shrink may spend on one failing scenario. */
const SHRINK_RUNS = 80;
/** The sweep's own bound; the measured runtime is printed with every run. */
const SWEEP_TIMEOUT_MS = 60 * 60 * 1000;
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

/**
 * Seeds still failing, as `generator:seed`, and the fix each waits for: the
 * sweep skips them, and their fixed scenarios below are marked `failing` until
 * that fix lands.
 */
const OPEN: ReadonlyMap<string, string> = new Map<string, string>();

/** The conversation a verdict's work context or life belongs to: `…sim<run>-c<N>…`. */
const conversationOf = (verdict: Verdict): number | null => {
  const match = /-c(\d+)/.exec(verdict.detail);
  return match === null ? null : Number(match[1]);
};

const isStatusWriterOf = (event: SimEvent, c: number): boolean =>
  (event.kind === "intent" || event.kind === "end") && event.c === c;

/** Two of a conversation's status writers at once, one of them a set_intent. */
const hasConcurrentIntent = (events: readonly SimEvent[], c: number): boolean =>
  events.some(
    (event) =>
      event.kind === "par" &&
      isStatusWriterOf(event.a, c) &&
      isStatusWriterOf(event.b, c) &&
      (event.a.kind === "intent" || event.b.kind === "intent"),
  );

/**
 * DOCUMENTED RESIDUAL CLASSES: the sweep counts and prints them, and does not
 * fail on them (docs/1.0/loss-accounting.md).
 *   I1u — a drop the disk refused to write down, the ledger line and its
 *         fallback marker both (ENOSPC or EACCES on every write): nothing on
 *         that disk can count it.
 *   L1  — a status set_intent left behind (I4) on a conversation where a
 *         set_intent ran beside another set_intent or its SessionEnd: the
 *         acknowledgement follows the order answers arrive in, not the order
 *         the hub applied them (review-2 round 8, L1, accepted in round 9).
 */
const residualOf = (events: readonly SimEvent[], verdict: Verdict): string | null => {
  if (verdict.invariant === "I1u") {
    return "I1u";
  }
  const c = conversationOf(verdict);
  return verdict.invariant === "I4" && c !== null && hasConcurrentIntent(events, c) ? "L1" : null;
};

const unexplained = (verdicts: readonly Verdict[], events: readonly SimEvent[]): readonly Verdict[] =>
  verdicts.filter((verdict) => residualOf(events, verdict) === null);

describe("the spool, simulated", () => {
  test(
    `${String(SEEDS)} seeded scenarios (${GENERATOR_NAME}) keep I1–I6`,
    async () => {
      const started = Date.now();
      const failing: string[] = [];
      const residual: string[] = [];
      const reports: string[] = [];
      const totals = { seeds: 0, overCountSeeds: 0, overCounted: 0, lost: 0, captured: 0, uncountable: 0 };
      for (let seed = SEED_BASE; seed < SEED_BASE + SEEDS; seed += 1) {
        if (OPEN.has(`${GENERATOR_NAME}:${String(seed)}`)) {
          continue;
        }
        const events = scenarioOf(seed, GENERATOR);
        const { run, verdicts } = await verdictsOf(events);
        const numbers = accountingStats(run);
        totals.seeds += 1;
        totals.captured += numbers.captured;
        totals.lost += numbers.lost;
        totals.overCounted += numbers.overCounted;
        totals.overCountSeeds += numbers.overCounted > 0 ? 1 : 0;
        totals.uncountable += run.uncountable.count;
        const label = (classes: readonly string[]) => `${String(seed)}:${[...new Set(classes)].join("+")}`;
        const residualClasses = verdicts.flatMap((verdict) => residualOf(events, verdict) ?? []);
        if (residualClasses.length > 0) {
          residual.push(label(residualClasses));
        }
        const failed = unexplained(verdicts, events);
        if (failed.length > 0) {
          failing.push(label(failed.map((verdict) => verdict.invariant)));
          if (reports.length < MAX_REPORTED) {
            reports.push(await reportOf(seed, events));
          }
        }
      }
      console.log(
        `[spool-simulation] ${String(totals.seeds)} seeds (${GENERATOR_NAME}) from ${String(SEED_BASE)} in ${String(Date.now() - started)} ms`,
      );
      console.log(
        `[spool-simulation] over-count: ${String(totals.overCountSeeds)} seeds, ${String(totals.overCounted)} records counted lost that the hub holds; captured ${String(totals.captured)}, lost ${String(totals.lost)}`,
      );
      console.log(
        `[spool-simulation] residual ${String(residual.length)} (I1u: ${String(totals.uncountable)} records the disk let nothing count; L1: set_intent beside set_intent or SessionEnd): ${residual.join(" ")}`,
      );
      console.log(`[spool-simulation] failing ${String(failing.length)}: ${failing.join(" ")}`);
      expect(reports.join("\n\n")).toBe("");
    },
    SWEEP_TIMEOUT_MS,
  );
});

const start = (c: number): SimEvent => ({ kind: "start", c });
const edit = (c: number): SimEvent => ({ kind: "edit", c });
const end = (c: number): SimEvent => ({ kind: "end", c });
const hubEnd = (c: number): SimEvent => ({ kind: "hubEnd", c });
const fault = (kind: "records503" | "recordsLate" | "registersDown" | "endsLate", count: number, after: number): SimEvent => ({
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

const par = (a: SimEvent, b: SimEvent): SimEvent => ({ kind: "par", a, b });
const age = (c: number): SimEvent => ({ kind: "age", c });
const slow = (ms: number, count: number, after: number): SimEvent => ({ kind: "fault", fault: "slow", count, after, ms });

interface Found extends Probe {
  /** The fix it waits for while it still fails (the sweep skips its seed). */
  readonly open?: string;
  /** Open and racy: it fails only on some interleavings of its two processes, so it is skipped, not marked failing. */
  readonly racy?: boolean;
}

/**
 * WHAT THE ROUND-7 REVIEW'S EXTENDED SWEEP FOUND, shrunk: each named by its
 * seed, the invariant it broke and the finding it is (H1, M1, M3, L1, L2), and
 * two the checker misread (seeds 1018 and 1034: a conversation SessionEnd
 * ended within the step, read as live before it).
 */
const ROUND_7: readonly Found[] = [
  {
    name: "seed 455 (I2, H1): an ended life's straggler, its host dead a week, sent into it by a successor",
    events: [start(1), hubEnd(1), fault("registersDown", 1, 1), start(0), edit(1), par(edit(0), edit(1)), age(1)],
  },
  {
    name: "seed 10005 (I2, H1): the same after a crash",
    events: [start(0), hubEnd(0), crash(4, "before"), edit(0), age(0)],
  },
  {
    name: "seed 11379 (I2, H1): the same behind a slow hub",
    events: [start(0), hubEnd(0), slow(1400, 2, 0), edit(0), intent(0, "blocked"), edit(0), age(0)],
  },
  {
    name: "probe A1 (I2, H1): a refused life's straggler, then a week for everything on disk",
    events: [start(0), edit(0), hubEnd(0), edit(0), { kind: "straggle", c: 0 }, age(0), start(1)],
  },
  {
    name: "probe A3 (I2, H1): a healed life's open debt, its life refused as ended, then a week",
    events: [start(0), edit(0), hubEnd(0), fault("records503", 1, 1), edit(0), hubEnd(0), intent(0, "blocked"), age(0), start(1)],
  },
  {
    name: "seed 782 (I2, M1): a reload's re-fire beside SessionEnd, then set_intent beside it, filed past the end",
    events: [
      start(0),
      fault("records503", 2, 1),
      fault("recordsLate", 1, 0),
      par(start(0), end(0)),
      par(intent(0, "implementing"), end(0)),
    ],
  },
  {
    name: "seed 10895 (I4, M3): a reaped host's work context reverted the status set_intent set",
    events: [crash(7, "before"), start(1), intent(1, "done"), fault("registersDown", 2, 0), age(1), start(0)],
  },
  {
    name: "seed 184 (I4, L1): set_intent beside a SessionStart re-fire",
    events: [start(0), par(intent(0, "implementing"), start(0))],
  },
  {
    name: "seed 1255 (I4, L1): the same, the other way round",
    events: [start(1), { kind: "refuseWc", c: 0 }, par(intent(1, "blocked"), start(1))],
  },
  {
    name: "seed 1384 (I4, L1): a re-fire beside set_intent",
    events: [start(0), par(start(0), intent(0, "implementing"))],
  },
  {
    name: "seed 1605 (I4, L1): the same on a second conversation",
    events: [start(1), par(start(1), intent(1, "implementing"))],
  },
  {
    name: "seed 1715 (I4, L1): a re-fire beside set_intent blocked",
    events: [start(0), par(start(0), intent(0, "blocked"))],
  },
  {
    name: "seed 11151 (I4, L1): set_intent beside a re-fire, then a crash",
    events: [start(0), par(intent(0, "blocked"), start(0)), crash(7, "before")],
  },
  {
    name: "seed 11274 (I4, L1): a re-fire beside set_intent, another re-fire, a crash",
    events: [start(1), par(start(1), intent(1, "blocked")), start(1), crash(4, "after")],
  },
  {
    name: "seed 11362 (I4, L1): set_intent done beside a re-fire",
    events: [start(0), par(intent(0, "done"), start(0))],
  },
  {
    name: "seed 11645 (I4, L1): a re-fire beside set_intent implementing",
    events: [start(0), par(start(0), intent(0, "implementing"))],
  },
  {
    name: "seed 134 (I3, L2): two SessionStarts of one host session at once, a register refused",
    events: [fault("registersDown", 2, 1), par(start(1), start(1))],
  },
  {
    name: "seed 1933 (I3, L2): a SessionStart beside a SessionEnd after a crashed end",
    events: [start(0), crash(4, "before"), end(0), par(start(0), end(0))],
  },
  {
    name: "seed 11285 (I3, L2): two SessionStarts at once after a crash, registers refused",
    events: [crash(1, "before"), fault("registersDown", 2, 2), par(start(0), start(0))],
  },
  {
    name: "seed 11683 (I3, L2): an edit beside a resume after an ended life",
    events: [start(0), hubEnd(0), crash(3, "after"), start(0), end(0), par(edit(0), start(0))],
  },
  {
    name: "seed 1018 (checker): SessionEnd beside a successor's SessionStart, read as live",
    events: [start(1), fault("records503", 2, 0), edit(1), par(end(1), start(0))],
  },
  {
    name: "seed 1034 (checker): two SessionEnds at once, read as live",
    events: [start(1), start(0), fault("recordsLate", 2, 1), edit(1), edit(1), par(end(1), end(0))],
  },
  {
    name: "seed 10009 (checker, production timing): a resume beside a successor's drain of its ended spool, read as live",
    events: [
      start(0),
      start(1),
      fault("records503", 1, 2),
      edit(1),
      edit(0),
      edit(1),
      fault("recordsLate", 1, 0),
      end(1),
      par(edit(0), start(1)),
    ],
  },
  {
    name: "seed 10102 (I4, L1, production timing): set_intent beside a re-fire",
    events: [start(1), par(intent(1, "implementing"), start(1))],
  },
  {
    name: "seed 11955 (I4, L1, production timing): set_intent done beside a re-fire",
    events: [start(1), par(intent(1, "done"), start(1))],
  },
  {
    name: "seed 1035 (I4, L1, production timing): set_intent beside a re-fire, a second conversation open",
    events: [start(0), start(1), edit(0), par(intent(0, "done"), start(0))],
  },
  {
    name: "seed 1501 (I4, L1, production timing): set_intent blocked beside a re-fire after an edit",
    events: [start(0), edit(0), par(intent(0, "blocked"), start(0))],
  },
  {
    name: "seed 912 (I4, L1, production timing): a re-fire beside set_intent behind a slow hub",
    events: [start(0), edit(0), slow(1700, 1, 1), edit(0), par(start(0), intent(0, "blocked"))],
  },
  {
    name: "seed 1494 (I4, L1, production timing): a re-fire beside set_intent after a crashed start",
    events: [start(0), crash(1, "before"), edit(0), par(start(0), intent(0, "done"))],
  },
  {
    name: "seed 11268 (I4, L1, production timing): a re-fire beside set_intent, then a flush beside an edit",
    events: [start(0), par(start(0), intent(0, "blocked")), par(edit(0), { kind: "flush", c: 0 })],
  },
  {
    name: "seed 11974 (I3, L2, production timing): a resume onto the life a heal's unheard register opened, behind a slow hub",
    events: [start(0), slow(600, 1, 1), hubEnd(0), edit(0), end(0), par(start(0), end(0))],
  },
];

const NIGHT: SimEvent = { kind: "night" };
const VACATION: SimEvent = { kind: "vacation" };
const wake = (c: number): SimEvent => ({ kind: "wake", c });
const recover = (c: number): SimEvent => ({ kind: "recover", c });
const beat = (c: number): SimEvent => ({ kind: "beat", c });
const straggle = (c: number): SimEvent => ({ kind: "straggle", c });
const ioFail = (at: number, count: number): SimEvent => ({ kind: "ioFail", at, count });
/** Conversation 1 starting and ending `count` times: each SessionEnd writes its life into the refused-lives note (M1). */
const manyEnds = (count: number): readonly SimEvent[] => Array.from({ length: count }, () => [start(1), end(1)]).flat();
const noDrops = (run: Run): boolean => run.drops.length === 0;
const counted = (run: Run): boolean => run.uncountable.count > 0;


/**
 * WHAT THE ROUND-8 REVIEW FOUND (review-2 round 8): its probes, and every seed
 * its `io`, `sleep` and `focus` sweeps found failing, shrunk. The `io` seeds
 * are the documented residual I1u — a drop the disk refused to write down
 * anywhere — and each asserts that this, and only this, is what happened.
 */
const ROUND_8: readonly Found[] = [
  {
    name: "probe N1: a night — the hub reaps the sleeping session — then the conversation goes on",
    events: [start(0), edit(0), intent(0, "blocked"), NIGHT, edit(0), intent(0, "done"), edit(0), end(0)],
  },
  {
    name: "probe N2: a night, then a SessionStart re-fire and set_intent",
    events: [start(0), edit(0), NIGHT, start(0), intent(0, "reviewing"), edit(0)],
  },
  {
    name: "probe H1: the first hook after a night beats before anything revives the reaped life, and a parallel hook's record of it goes",
    events: [start(0), edit(0), NIGHT, beat(0), straggle(0), edit(0)],
    shows: noDrops,
  },
  {
    name: "probe H0 (control for H1): the same without the beat — the record revives the reaped life",
    events: [start(0), edit(0), NIGHT, straggle(0), edit(0)],
    shows: noDrops,
  },
  {
    name: "probe E1: a resumed life reaped while the laptop slept a week, resumed again: one epoch, no position issued twice",
    events: [start(0), edit(0), edit(0), end(0), start(0), edit(0), edit(0), edit(0), VACATION, start(1), wake(0), start(0), edit(0), edit(0), edit(0), edit(0)],
  },
  {
    name: "probe E2: the same life recovered by a PostToolUse after the week (connector-claude recoverState)",
    events: [start(0), edit(0), edit(0), end(0), start(0), edit(0), edit(0), VACATION, start(1), wake(0), recover(0), edit(0)],
  },
  {
    name: "probe E3: a first life reaped while asleep, resumed: one epoch",
    events: [start(0), edit(0), edit(0), VACATION, start(1), wake(0), start(0), edit(0), edit(0)],
  },
  {
    name: "probe E4: a first life reaped while asleep, recovered by a PostToolUse",
    events: [start(0), edit(0), edit(0), VACATION, start(1), wake(0), recover(0), edit(0)],
  },
  {
    name: "probe C1: a refused life's straggler, 64 later session ends, then a week",
    events: [start(0), edit(0), hubEnd(0), edit(0), straggle(0), ...manyEnds(64), age(0), start(2)],
  },
  {
    name: "probe C0 (control for C1): the same with 8 later session ends",
    events: [start(0), edit(0), hubEnd(0), edit(0), straggle(0), ...manyEnds(8), age(0), start(2)],
  },
  {
    name: "probe L1: SessionEnd's end committed but its answer lost, then a hook still in flight appends, and a successor flushes",
    events: [start(0), edit(0), fault("endsLate", 1, 0), end(0), straggle(0), start(1), edit(1)],
  },
  {
    name: "probe L0 (control for L1): the same end heard",
    events: [start(0), edit(0), end(0), straggle(0), start(1), edit(1)],
  },
  {
    name: "sleep seed 3 (I3): a first life asleep a week, resumed after another conversation started",
    events: [start(0), VACATION, start(2), wake(0), start(0)],
  },
  {
    name: "sleep seed 365 (I3): a recovery after a crashed resume of an ended life",
    events: [start(0), end(0), crash(2, "after"), start(0), recover(0)],
  },
  {
    name: "sleep seed 935 (I3): a recovery after the end of a life the hub ended",
    events: [start(0), crash(7, "before"), hubEnd(0), edit(0), end(0), recover(0)],
  },
  {
    name: "sleep seed 936 (I3): a recovery after a resume killed after its third write",
    events: [start(0), end(0), crash(3, "after"), start(0), recover(0)],
  },
  {
    name: "sleep seed 1955 (I3): a recovery after a resume killed before its third write",
    events: [start(0), end(0), crash(3, "before"), start(0), recover(0)],
  },
  {
    name: "focus seed 361 (I3, L4): SessionEnd beside a re-fire behind a slow hub",
    events: [start(1), slow(600, 2, 1), edit(1), fault("records503", 2, 1), par({ kind: "flush", c: 1 }, intent(1, "done")), par(end(1), start(1))],
  },
  {
    name: "focus seed 662 (I3, L4): a start beside an end, twice, behind a slow hub",
    events: [
      par(start(0), end(0)),
      slow(1700, 1, 2),
      par(start(0), { kind: "flush", c: 0 }),
      fault("recordsLate", 2, 1),
      edit(0),
      par(end(0), start(0)),
      edit(0),
    ],
  },
  {
    name: "focus seed 1811 (I3, L4): the generated scenario",
    events: scenarioOf(1811, GENERATORS.focus),
  },
  {
    name: "focus seed 18 (I4): two set_intents of one conversation at once behind a slow hub",
    events: [start(0), par(intent(0, "blocked"), start(0)), slow(1700, 1, 1), par(intent(0, "done"), intent(0, "blocked"))],
  },
  {
    name: "focus seed 313 (I4): the generated scenario",
    events: scenarioOf(313, GENERATORS.focus),
  },
  {
    name: "focus seed 399 (I4): SessionEnd beside set_intent behind a slow hub",
    events: [start(0), par(intent(0, "done"), { kind: "flush", c: 0 }), slow(1400, 2, 0), par(end(0), intent(0, "implementing"))],
  },
  {
    name: "focus seed 1786 (I4): two set_intents of one conversation at once, answers lost",
    events: [start(0), par(edit(0), intent(0, "done")), fault("recordsLate", 2, 2), edit(0), par(intent(0, "implementing"), intent(0, "done"))],
  },
  {
    name: "focus seed 1791 (I4): set_intent beside a re-fire and an end behind a slow hub",
    events: [
      start(0),
      par(start(0), intent(0, "blocked")),
      slow(600, 2, 2),
      par(intent(0, "implementing"), start(0)),
      par(end(0), intent(0, "implementing")),
    ],
  },
  ...[
    { seed: 112, events: [start(1), ioFail(3, 6), hubEnd(1), edit(1)] },
    { seed: 252, events: [ioFail(8, 17), { kind: "refuseWc", c: 1 } as SimEvent, par(start(1), edit(1))] },
    {
      seed: 894,
      events: [start(0), start(2), fault("records503", 2, 1), edit(2), hubEnd(2), edit(0), edit(2), ioFail(1, 5), { kind: "oldFlush", c: 2 } as SimEvent],
    },
    { seed: 924, events: [{ kind: "refuseWc", c: 0 } as SimEvent, start(0), ioFail(3, 8), edit(0)] },
    { seed: 940, events: [start(1), hubEnd(1), ioFail(5, 29), par(edit(1), end(0))] },
    { seed: 950, events: [start(0), slow(1400, 2, 2), hubEnd(0), start(2), edit(0), edit(2), ioFail(3, 29), edit(0)] },
    { seed: 1022, events: [start(0), hubEnd(0), ioFail(4, 11), edit(0)] },
    { seed: 1359, events: [start(2), ioFail(5, 14), hubEnd(2), edit(2)] },
    { seed: 1957, events: [crash(5, "before"), start(0), ioFail(4, 7), edit(0)] },
  ].map(({ seed, events }) => ({
    name: `io seed ${String(seed)} (residual I1u): a drop the disk refused to write down, and nothing else`,
    events,
    shows: counted,
  })),
  {
    name: "io seed 1993 (I1, found by round 9's sweep): a record the hub held, in a batch whose heal stayed pending, withheld once its conversation was over",
    events: scenarioOf(1993, GENERATORS.io),
  },
];

/**
 * EVERY KIND OF DROP NAMES ITS RECORDS (review-2 round 8, M4): the per-record
 * I1 needs each drop the connector can write to occur at least once — an
 * expiry and an `ignored` answer the random sweep rarely reaches.
 */
const PER_RECORD: readonly Probe[] = [
  {
    name: "an ended conversation's spool a week old expires, and the expiry names its records",
    events: [
      start(0),
      fault("records503", 6, 0),
      edit(0),
      end(0),
      start(1),
      age(1),
      fault("records503", 6, 0),
      start(2),
    ],
    shows: (run) => run.drops.some((drop) => drop.reason === "expired" && drop.ids.length === drop.count),
  },
  {
    name: "a batch the hub ignores is counted, and the drop names its records",
    events: [start(0), { kind: "ignore", count: 1 }, edit(0)],
    shows: (run) => run.drops.some((drop) => drop.reason === "ignored" && drop.ids.length === drop.count),
  },
];

describe("every kind of drop names its records (per-record I1)", () => {
  for (const probe of PER_RECORD) {
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

describe("what the round-7 review's sweep found, as fixed scenarios", () => {
  for (const found of ROUND_7) {
    const runner = found.open === undefined ? test : found.racy === true ? test.skip : test.failing;
    runner(
      found.open === undefined ? found.name : `${found.name} — open until ${found.open}`,
      async () => {
        const { verdicts } = await verdictsOf(found.events);
        expect(said(verdicts)).toEqual([]);
      },
      PROBE_TIMEOUT_MS,
    );
  }
});

describe("what the round-8 review found, as fixed scenarios", () => {
  for (const found of ROUND_8) {
    const runner = found.open === undefined ? test : found.racy === true ? test.skip : test.failing;
    runner(
      found.open === undefined ? found.name : `${found.name} — open until ${found.open}`,
      async () => {
        const { run, verdicts } = await verdictsOf(found.events);
        expect(said(unexplained(verdicts, found.events))).toEqual([]);
        expect(found.shows?.(run) ?? true).toBe(true);
      },
      PROBE_TIMEOUT_MS,
    );
  }
});

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
