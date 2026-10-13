/**
 * THE MUTATION PROOF IN SHARDS (scripts/mutation-shards.ts). 3,880 anchors
 * one after another take about seven hours on a hosted runner — the base
 * branch's 1,825 took 3 h 19 min — and GitHub ends a job at six. The proof
 * now runs as a matrix of shards, so what is asserted here is what makes the
 * shards one proof: every anchor runs in exactly one shard, a guard's anchors
 * share a shard (its unmutated run is paid once), the split is the same on
 * every runner, and the shards are even.
 */
import { describe, expect, test } from "bun:test";

import { MUTATIONS } from "../scripts/mutation-check.ts";
import { parseSelection, selectMutations, shardOf } from "../scripts/mutation-shards.ts";

/** The matrix ci.yml's `mutation` job runs. */
const SHARDS = 8;

const shards = Array.from({ length: SHARDS }, (_, at) => shardOf(MUTATIONS, at + 1, SHARDS));

describe("the mutation list in shards", () => {
  test("every anchor runs in exactly one shard", () => {
    // Arrange / Act
    const ran = shards.flat();

    // Assert: as many as the list holds, and each entry of the list once
    expect(ran).toHaveLength(MUTATIONS.length);
    expect(new Set(ran).size).toBe(MUTATIONS.length);
    expect(MUTATIONS.every((mutation) => ran.includes(mutation))).toBe(true);
  });

  test("a guard's anchors share one shard, so its unmutated run is paid once", () => {
    // Arrange / Act
    const shardsOfGuard = new Map<string, Set<number>>();
    shards.forEach((shard, at) => {
      for (const mutation of shard) {
        shardsOfGuard.set(mutation.test, new Set([...(shardsOfGuard.get(mutation.test) ?? []), at]));
      }
    });

    // Assert
    expect([...shardsOfGuard.entries()].filter(([, owners]) => owners.size !== 1).map(([guard]) => guard)).toEqual([]);
  });

  test("the shards are even: none holds more than another plus the largest guard's anchors", () => {
    // Arrange
    const perGuard = new Map<string, number>();
    for (const mutation of MUTATIONS) {
      perGuard.set(mutation.test, (perGuard.get(mutation.test) ?? 0) + 1);
    }
    const largestGuard = Math.max(...perGuard.values());

    // Act
    const sizes = shards.map((shard) => shard.length);

    // Assert
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(largestGuard);
  });

  test("the split is the same every time it is made", () => {
    // Act
    const again = Array.from({ length: SHARDS }, (_, at) => shardOf(MUTATIONS, at + 1, SHARDS));

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
});

describe("choosing what a run proves", () => {
  test("no argument runs the whole list", () => {
    expect(selectMutations(MUTATIONS, [])).toHaveLength(MUTATIONS.length);
  });

  test("--shard k/n runs that shard", () => {
    expect(selectMutations(MUTATIONS, ["--shard", "3/8"])).toEqual(shardOf(MUTATIONS, 3, SHARDS));
  });

  test("--label runs exactly the anchors with that label", () => {
    // Arrange
    const label = MUTATIONS[0]?.label ?? "";

    // Act
    const chosen = selectMutations(MUTATIONS, ["--label", label]);

    // Assert
    expect(chosen.length).toBeGreaterThan(0);
    expect(chosen.every((mutation) => mutation.label === label)).toBe(true);
  });

  test.each([["0/8"], ["9/8"], ["3"], ["a/b"], ["2/0"]])("a shard written %s is refused before anything runs", (written) => {
    expect(() => parseSelection(["--shard", written])).toThrow();
  });

  test("a label no anchor has is refused, so a typo never proves nothing and passes", () => {
    expect(() => selectMutations(MUTATIONS, ["--label", "no anchor is called this"])).toThrow();
  });
});
