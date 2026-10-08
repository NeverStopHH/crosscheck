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
 * ledger calls lost that the hub holds. SIM_REPORT_DIR names a directory the
 * sweep writes `<generator>.json` into: its failing seeds, their shrunk traces,
 * its residuals and its over-count — what the nightly workflow uploads.
 *
 * EVERY SEED A SWEEP EVER FOUND FAILING is in the historical corpus
 * (simulation/seed-corpus.ts) and runs here as a fixed scenario; the probes
 * below are the reviewers' hand-written ones. PR CI runs 300 seeds of
 * `shipped`; the nightly workflow (.github/workflows/simulation-nightly.yml)
 * and the release-candidate sweep run every generator wide, through
 * scripts/sim-sweep.ts (docs/1.0/loss-accounting.md).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import "./simulation/sim-hooks.ts";
import { accountingStats, checkInvariants } from "./simulation/sim-invariants.ts";
import type { Verdict } from "./simulation/sim-invariants.ts";
import { startSimHub } from "./simulation/sim-hub.ts";
import type { SimHub } from "./simulation/sim-hub.ts";
import { describeEvent, execute, GENERATORS, scenarioOf } from "./simulation/sim-world.ts";
import type { GeneratorName, Run, SimEvent } from "./simulation/sim-world.ts";
import { corpusName, SEED_CORPUS } from "./simulation/seed-corpus.ts";
import type { CorpusSeed, ResidualClass } from "./simulation/seed-corpus.ts";
import {
  abandon,
  age,
  beat,
  crash,
  edit,
  end,
  fault,
  hubEnd,
  intent,
  NIGHT,
  recover,
  start,
  straggle,
  VACATION,
  wake,
} from "./simulation/sim-events.ts";
import { parseSweepArgs, SWEEP_GENERATORS } from "../scripts/sim-sweep.ts";
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
const MINUTE_MS = 60 * 1000;
/**
 * The sweep's own bound, grown with the seeds a wide sweep asks for: 1.5 s a
 * seed is about three times what the slowest generator (`focus`) takes on a
 * laptop, which leaves room for a CI runner. The measured runtime is printed
 * with every run.
 */
const SWEEP_MS_PER_SEED = 1500;
const SWEEP_TIMEOUT_MS = Math.max(60 * MINUTE_MS, SEEDS * SWEEP_MS_PER_SEED);
const PROBE_TIMEOUT_MS = MINUTE_MS;
/** Where a wide sweep writes what it found (the nightly workflow's artifacts), or nowhere. */
const REPORT_DIR = process.env["SIM_REPORT_DIR"];

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

/** A failing seed, shrunk: its minimal events (replayable as a corpus entry) and what they broke. */
interface Report {
  readonly seed: number;
  readonly events: readonly SimEvent[];
  readonly text: string;
}

const reportOf = async (seed: number, events: readonly SimEvent[]): Promise<Report> => {
  const minimal = await shrink(events);
  const { run, verdicts } = await verdictsOf(minimal);
  const text = [
    `seed ${String(seed)}: ${String(events.length)} events, shrunk to ${String(minimal.length)}`,
    `  events: ${minimal.map(describeEvent).join(" · ")}`,
    ...verdicts.map((verdict) => `  ${verdict.invariant}: ${verdict.detail}`),
    "  trace:",
    ...run.trace.map((line) => `    ${line}`),
  ].join("\n");
  return { seed, events: minimal, text };
};

const said = (verdicts: readonly Verdict[]): readonly string[] =>
  verdicts.map((verdict) => `${verdict.invariant}: ${verdict.detail}`);

/**
 * Seeds still failing, as `generator:seed`, and the fix each waits for: the
 * corpus entries marked `open`. The sweep skips them, and their fixed
 * scenarios below are marked `failing` until that fix lands.
 */
const OPEN: ReadonlyMap<string, string> = new Map(
  SEED_CORPUS.flatMap((entry) => (entry.open === undefined ? [] : [[`${entry.generator}:${String(entry.seed)}`, entry.open] as const])),
);

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
const residualOf = (events: readonly SimEvent[], verdict: Verdict): ResidualClass | null => {
  if (verdict.invariant === "I1u") {
    return "I1u";
  }
  const c = conversationOf(verdict);
  return verdict.invariant === "I4" && c !== null && hasConcurrentIntent(events, c) ? "L1" : null;
};

const ALL_RESIDUALS: readonly ResidualClass[] = ["I1u", "L1"];

/** The verdicts no residual class explains — among `allowed`, every class the sweep counts by default. */
const unexplained = (
  verdicts: readonly Verdict[],
  events: readonly SimEvent[],
  allowed: readonly ResidualClass[] = ALL_RESIDUALS,
): readonly Verdict[] =>
  verdicts.filter((verdict) => {
    const residual = residualOf(events, verdict);
    return residual === null || !allowed.includes(residual);
  });

/** What a wide sweep found, for the nightly workflow to upload (SIM_REPORT_DIR). */
const writeSweepReport = async (summary: Record<string, unknown>): Promise<void> => {
  if (REPORT_DIR === undefined) {
    return;
  }
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(join(REPORT_DIR, `${GENERATOR_NAME}.json`), `${JSON.stringify(summary, null, 2)}\n`);
};

describe("the spool, simulated", () => {
  test(
    `${String(SEEDS)} seeded scenarios (${GENERATOR_NAME}) keep I1–I6`,
    async () => {
      const started = Date.now();
      const failing: string[] = [];
      const residual: string[] = [];
      const reports: Report[] = [];
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
      await writeSweepReport({
        generator: GENERATOR_NAME,
        base: SEED_BASE,
        seeds: totals.seeds,
        durationMs: Date.now() - started,
        failing,
        reports,
        residual,
        overCount: { seeds: totals.overCountSeeds, records: totals.overCounted },
        captured: totals.captured,
        lost: totals.lost,
        uncountable: totals.uncountable,
      });
      expect(reports.map((report) => report.text).join("\n\n")).toBe("");
    },
    SWEEP_TIMEOUT_MS,
  );
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

/**
 * THE ROUND-7 REVIEW'S PROBES (the seeds its extended sweep found are in the
 * corpus, simulation/seed-corpus.ts).
 */
const ROUND_7_PROBES: readonly Probe[] = [
  {
    name: "probe A1 (I2, H1): a refused life's straggler, then a week for everything on disk",
    events: [start(0), edit(0), hubEnd(0), edit(0), straggle(0), age(0), start(1)],
  },
  {
    name: "probe A3 (I2, H1): a healed life's open debt, its life refused as ended, then a week",
    events: [start(0), edit(0), hubEnd(0), fault("records503", 1, 1), edit(0), hubEnd(0), intent(0, "blocked"), age(0), start(1)],
  },
];

/**
 * THE PR #75 REVIEW'S SEEDS, AS FIXED SCENARIOS (the seeds themselves are in
 * the corpus, simulation/seed-corpus.ts).
 */
const PR75_PROBES: readonly Probe[] = [
  {
    // set_intent's hooked writes: the new status (1), its position (2), the
    // post's sync stamp (3), then the old status put back (4).
    name: "probe K1 (I2, sleep 31110): set_intent refused as ended, killed as it puts the status back, then a week: the dead host's last word is withheld",
    events: [start(0), hubEnd(0), crash(4, "before"), intent(0, "blocked"), abandon(0)],
    shows: (run) => run.drops.some((drop) => drop.reason === "withheld" && (drop.kinds["work_context"] ?? 0) > 0),
  },
];

/** Conversation 1 starting and ending `count` times: each SessionEnd writes its life into the refused-lives note (M1). */
const manyEnds = (count: number): readonly SimEvent[] => Array.from({ length: count }, () => [start(1), end(1)]).flat();
const noDrops = (run: Run): boolean => run.drops.length === 0;

/**
 * THE ROUND-8 REVIEW'S PROBES (review-2 round 8; the seeds its `io`, `sleep`
 * and `focus` sweeps found are in the corpus, simulation/seed-corpus.ts).
 */
const ROUND_8_PROBES: readonly Probe[] = [
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

describe("the round-7 and round-8 reviews' probes, and the PR #75 review's, as fixed scenarios", () => {
  for (const probe of [...ROUND_7_PROBES, ...ROUND_8_PROBES, ...PR75_PROBES]) {
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

const isWellFormed = (entry: CorpusSeed): boolean =>
  Number.isInteger(entry.seed) &&
  entry.seed > 0 &&
  entry.generator in GENERATORS &&
  entry.bug.length > 0 &&
  /^[0-9a-f]{8,40}$/.test(entry.fix) &&
  entry.events.length > 0;

describe("the wide sweep (scripts/sim-sweep.ts)", () => {
  test("sweeps every generator the simulation has, and the release candidate 5000 seeds of each", () => {
    // Arrange / Act
    const nightly = parseSweepArgs([]);
    const rc = parseSweepArgs(["--rc"]);

    // Assert
    expect([...SWEEP_GENERATORS].sort() as readonly string[]).toEqual(Object.keys(GENERATORS).sort());
    expect(nightly).toMatchObject({ generators: [...SWEEP_GENERATORS], seeds: 2000, base: 1 });
    expect(rc).toMatchObject({ generators: [...SWEEP_GENERATORS], seeds: 5000, base: 1 });
  });
});

describe("the historical seed corpus (simulation/seed-corpus.ts)", () => {
  test("names each seed's generator, invariant, bug and fixing commit, and no entry twice", () => {
    const names = SEED_CORPUS.map(corpusName);
    expect(SEED_CORPUS.filter((entry) => !isWellFormed(entry)).map(corpusName)).toEqual([]);
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
  });

  for (const entry of SEED_CORPUS) {
    const runner = entry.open === undefined ? test : entry.racy === true ? test.skip : test.failing;
    runner(
      entry.open === undefined ? corpusName(entry) : `${corpusName(entry)} — open until ${entry.open}`,
      async () => {
        const { run, verdicts } = await verdictsOf(entry.events);
        // Only the residual classes the entry names: a fixed bug allows none.
        expect(said(unexplained(verdicts, entry.events, entry.residual ?? []))).toEqual([]);
        expect(entry.shows?.(run) ?? true).toBe(true);
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
