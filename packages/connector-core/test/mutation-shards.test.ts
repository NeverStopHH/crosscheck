/**
 * THE MUTATION PROOF IN SHARDS (scripts/mutation-shards.ts). 3,880 anchors
 * one after another take about seven hours on a hosted runner — the base
 * branch's 1,825 took 3 h 19 min — and GitHub ends a job at six. The proof
 * now runs as a matrix of shards, so what is asserted here is what makes the
 * shards one proof: every anchor runs in exactly one shard, a guard's anchors
 * share a shard (its unmutated run is paid once), the split is the same on
 * every runner, and the shards take about the same time.
 *
 * DEALT BY SECONDS, NOT BY COUNT: eight shards of 487 anchors each ran 37 to
 * more than 85 minutes (CI run 38470399845), because one run of a guard costs
 * 0.1 s to more than 200 s. Each guard now costs its measured seconds per run
 * (scripts/mutation-guard-seconds.json) times its runs, and the one guard
 * that alone costs more than a shard's share is split, each part paying its
 * own unmutated run.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MUTATIONS } from "../scripts/mutation-check.ts";
import {
  costsOf,
  parseSelection,
  planShards,
  readGuardSeconds,
  selectMutations,
  shardOf,
} from "../scripts/mutation-shards.ts";

const CI_YML = join(import.meta.dir, "..", "..", "..", ".github", "workflows", "ci.yml");

/** The matrix ci.yml's `mutation` job runs. */
const SHARDS = 10;

/**
 * The longest a shard may be predicted to take: half the job's
 * `timeout-minutes`, so a runner twice as slow as the measured one still
 * finishes.
 */
const SHARD_BUDGET_MINUTES = 60;

const SECONDS = readGuardSeconds();
const plan = planShards(MUTATIONS, SHARDS, SECONDS);
const shards = plan.shards;
const costs = costsOf(MUTATIONS, SECONDS);
/** A shard's fair share of the whole list's cost. */
const share = [...costs.values()].reduce((sum, cost) => sum + cost, 0) / SHARDS;

describe("the mutation list in shards", () => {
  test("every anchor runs in exactly one shard", () => {
    // Arrange / Act
    const ran = shards.flat();

    // Assert: as many as the list holds, and each entry of the list once
    expect(ran).toHaveLength(MUTATIONS.length);
    expect(new Set(ran).size).toBe(MUTATIONS.length);
    expect(MUTATIONS.every((mutation) => ran.includes(mutation))).toBe(true);
  });

  test("a guard's anchors share one shard, so its unmutated run is paid once, unless it alone costs more than a shard's share", () => {
    // Arrange / Act
    const shardsOfGuard = new Map<string, Set<number>>();
    shards.forEach((shard, at) => {
      for (const mutation of shard) {
        shardsOfGuard.set(mutation.test, new Set([...(shardsOfGuard.get(mutation.test) ?? []), at]));
      }
    });
    const split = [...shardsOfGuard.entries()].filter(([, owners]) => owners.size !== 1).map(([guard]) => guard);

    // Assert
    expect(split.filter((guard) => (costs.get(guard) ?? 0) <= share)).toEqual([]);
  });

  test("the shards take about the same time: none is predicted longer than another plus the costliest guard", () => {
    // Arrange
    const costliestGuard = Math.max(...costs.values());

    // Act / Assert
    expect(Math.max(...plan.seconds) - Math.min(...plan.seconds)).toBeLessThanOrEqual(costliestGuard);
  });

  test(`no shard is predicted past ${String(SHARD_BUDGET_MINUTES)} minutes on the measured runner`, () => {
    expect(Math.max(...plan.seconds) / 60).toBeLessThanOrEqual(SHARD_BUDGET_MINUTES);
  });

  test("a shard is the plan's shard", () => {
    expect(shardOf(MUTATIONS, 3, SHARDS, SECONDS)).toEqual(shards[2] ?? []);
  });

  test("the split is the same every time it is made", () => {
    // Act
    const again = Array.from({ length: SHARDS }, (_, at) => shardOf(MUTATIONS, at + 1, SHARDS, readGuardSeconds()));

    // Assert
    expect(again.map((shard) => shard.map((mutation) => mutation.label))).toEqual(shards.map((shard) => shard.map((mutation) => mutation.label)));
  });

  test("a shard keeps the list's own order", () => {
    // Arrange / Act
    const order = new Map(MUTATIONS.map((mutation, at) => [mutation, at]));

    // Assert
    for (const shard of shards) {
      const positions = shard.map((mutation) => order.get(mutation) ?? -1);
      expect(positions).toEqual([...positions].sort((left, right) => left - right));
    }
  });

  test("ci.yml runs the matrix the split is made for, under the timeout the budget is half of", () => {
    // Arrange
    const workflow = readFileSync(CI_YML, "utf8");
    const job = workflow.slice(workflow.indexOf("name: Mutation proof ("));

    // Assert
    expect(job).toContain(`name: Mutation proof (\${{ matrix.shard }}/${String(SHARDS)})`);
    expect(job).toContain(`shard: [${Array.from({ length: SHARDS }, (_, at) => String(at + 1)).join(", ")}]`);
    expect(job).toContain(`--shard \${{ matrix.shard }}/${String(SHARDS)}`);
    expect(job).toContain(`timeout-minutes: ${String(SHARD_BUDGET_MINUTES * 2)}`);
  });
});

describe("what a guard costs", () => {
  const PACES = { "a.test.ts": 10, "b.test.ts": 2, "c.test.ts": 4 };
  const guarded = (test: string, label: string) => ({ label, test });

  test("a guard costs its unmutated run and one run per anchor, at its measured pace", () => {
    // Act
    const priced = costsOf([guarded("a.test.ts", "a1"), guarded("a.test.ts", "a2")], PACES);

    // Assert: 3 runs of 10 s
    expect(priced.get("a.test.ts")).toBe(30);
  });

  test("a guard the table never measured costs the table's median pace", () => {
    // Act: the median of 10, 2 and 4 is 4
    const priced = costsOf([guarded("new.test.ts", "n1")], PACES);

    // Assert: 2 runs of 4 s
    expect(priced.get("new.test.ts")).toBe(8);
  });

  test("an empty table is refused rather than pricing every guard at nothing", () => {
    expect(() => costsOf([guarded("a.test.ts", "a1")], {})).toThrow();
  });

  test("the costliest guard goes first to the emptiest shard, ties to the lower shard", () => {
    // Arrange: a costs 20, b 4 and c 8 — on two shards a stands alone
    const items = [guarded("b.test.ts", "b1"), guarded("a.test.ts", "a1"), guarded("c.test.ts", "c1")];

    // Act
    const first = shardOf(items, 1, 2, PACES).map((item) => item.label);
    const second = shardOf(items, 2, 2, PACES).map((item) => item.label);

    // Assert: the list's order kept within each shard
    expect(first).toEqual(["a1"]);
    expect(second).toEqual(["b1", "c1"]);
  });

  test("a guard costlier than a shard's share is split in list order, each part paying its own unmutated run", () => {
    // Arrange: a has 5 anchors (6 runs, 60 s); b and c 2 s each; the share of 3 shards is 64 / 3
    const items = [
      ...["a1", "a2", "a3", "a4", "a5"].map((label) => guarded("a.test.ts", label)),
      guarded("b.test.ts", "b1"),
      guarded("c.test.ts", "c1"),
    ];
    const paces = { "a.test.ts": 10, "b.test.ts": 1, "c.test.ts": 1 };

    // Act
    const split = planShards(items, 3, paces);

    // Assert: a in three parts of 2, 2 and 1 anchors — 30, 30 and 20 s — the small guards beside the cheapest
    expect(split.shards.map((shard) => shard.map((item) => item.label))).toEqual([["a1", "a2"], ["a3", "a4"], ["a5", "b1", "c1"]]);
    expect(split.seconds).toEqual([30, 30, 24]);
  });

  test("a guard is never split finer than one anchor a part", () => {
    // Arrange: one anchor whose two runs cost more than any share
    const split = planShards([guarded("a.test.ts", "a1"), guarded("b.test.ts", "b1")], 2, { "a.test.ts": 100, "b.test.ts": 1 });

    // Assert
    expect(split.shards.map((shard) => shard.map((item) => item.label))).toEqual([["a1"], ["b1"]]);
    expect(split.seconds).toEqual([200, 2]);
  });
});

describe("the measured table", () => {
  test("measured guards, every pace a positive number", () => {
    expect(Object.keys(SECONDS).length).toBeGreaterThan(0);
    expect(Object.values(SECONDS).every((pace) => Number.isFinite(pace) && pace > 0)).toBe(true);
  });
});

describe("choosing what a run proves", () => {
  test("no argument runs the whole list", () => {
    expect(selectMutations(MUTATIONS, [], SECONDS)).toHaveLength(MUTATIONS.length);
  });

  test("--shard k/n runs that shard", () => {
    expect(selectMutations(MUTATIONS, ["--shard", "3/10"], SECONDS)).toEqual(shardOf(MUTATIONS, 3, SHARDS, SECONDS));
  });

  test("--label runs exactly the anchors with that label", () => {
    // Arrange
    const label = MUTATIONS[0]?.label ?? "";

    // Act
    const chosen = selectMutations(MUTATIONS, ["--label", label], SECONDS);

    // Assert
    expect(chosen.length).toBeGreaterThan(0);
    expect(chosen.every((mutation) => mutation.label === label)).toBe(true);
  });

  test.each([["0/8"], ["9/8"], ["3"], ["a/b"], ["2/0"]])("a shard written %s is refused before anything runs", (written) => {
    expect(() => parseSelection(["--shard", written])).toThrow();
  });

  test("a label no anchor has is refused, so a typo never proves nothing and passes", () => {
    expect(() => selectMutations(MUTATIONS, ["--label", "no anchor is called this"], SECONDS)).toThrow();
  });
});
