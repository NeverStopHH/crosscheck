import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { AttemptFacts, AttemptInput } from "../bench/at7/attempt.ts";
import type { VoidReason } from "../bench/at7/detect.ts";
import { runSweep } from "../bench/at7/driver.ts";
import type { SweepInput } from "../bench/at7/driver.ts";
import type { Slot } from "../bench/at7/manifest.ts";
import type { RunOutcome } from "../bench/at7/report.ts";

/**
 * The sweep (A1.6, A2.5): a void is re-run IN ITS SLOT, every void attempt
 * counts toward the cap of five, resume continues rather than restarts, and
 * an attempt directory without an outcome counts as a void. Every attempt
 * lives under an opaque id (A2.4). runAttempt is faked; the store is real, in
 * a temp dir.
 */
const ORDER: readonly Slot[] = [
  { index: 0, arm: { kind: "control" } },
  { index: 1, arm: { kind: "treatment", payload: "P3" } },
];

const outcomeFor = (input: AttemptInput, voids: readonly VoidReason[] = []): RunOutcome => ({
  slotIndex: input.slot.index,
  arm: input.slot.arm,
  attemptId: input.attemptId,
  attempt: input.attempt,
  token: "at7-0000000000",
  hits: [],
  voids,
  taskSucceeded: voids.length === 0,
  toolCallCount: 3,
  turns: 2,
  durationMs: 1000,
  costUsd: 0.01,
  filesRead: [],
  filesWritten: [],
  filesEdited: [],
  bashCommands: [],
  toolNames: [],
  todoItems: [],
  claudeVersion: "2.1.286 (Claude Code)",
});

const factsFor = (input: AttemptInput, voids: readonly VoidReason[] = []): AttemptFacts => ({
  outcome: outcomeFor(input, voids),
  claudeVersion: "2.1.286 (Claude Code)",
  model: "claude-opus-5-5",
  mcpServers: ["crosscheck"],
  plugins: [],
  briefing: null,
  timedOut: false,
});

describe("runSweep", () => {
  let outDir: string;
  let workBase: string;
  const seen: AttemptInput[] = [];

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "sweep-out-"));
    workBase = await mkdtemp(join(tmpdir(), "sweep-work-"));
    seen.length = 0;
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
    await rm(workBase, { recursive: true, force: true });
  });

  const sweep = (
    run: (input: AttemptInput) => Promise<AttemptFacts>,
    overrides: Partial<SweepInput> = {},
  ) =>
    runSweep({
      order: ORDER,
      outDir,
      workBase,
      log: () => undefined,
      runAttempt: async (input) => {
        seen.push(input);
        return run(input);
      },
      ...overrides,
    });

  /** Writes an attempt dir as an earlier, interrupted sweep left it. */
  const plantAttempt = async (
    id: string,
    slot: Slot,
    attempt: number,
    voids: readonly VoidReason[] | null,
  ): Promise<void> => {
    const dir = join(outDir, "attempts", id);
    await mkdir(dir, { recursive: true });
    const record = { attemptId: id, slotIndex: slot.index, arm: slot.arm, attempt, workRoot: "/x", startedAt: "t" };
    await writeFile(join(dir, "attempt.json"), JSON.stringify(record), "utf8");
    if (voids !== null) {
      const input = { slot, attemptId: id, attempt, workRoot: "/x", resultsDir: dir };
      await writeFile(join(dir, "outcome.json"), JSON.stringify(outcomeFor(input, voids)), "utf8");
    }
  };

  test("a void attempt is re-run in its slot, and attempt numbers count up", async () => {
    // Arrange: slot 0's first attempt is void
    let calls = 0;

    // Act
    const result = await sweep(async (input) => {
      calls += 1;
      return factsFor(input, calls === 1 ? ["timed-out"] : []);
    });

    // Assert
    expect(seen.map((i) => [i.slot.index, i.attempt])).toEqual([
      [0, 1],
      [0, 2],
      [1, 1],
    ]);
    expect(result.voidAttempts).toBe(1);
    expect(result.aborted).toBe(false);
    expect(result.outcomes).toHaveLength(3);
  });

  test("every attempt sits under an opaque id that names no slot, arm or payload (A2.4)", async () => {
    // Act
    await sweep(async (input) => factsFor(input));

    // Assert
    for (const input of seen) {
      expect(basename(input.workRoot)).toMatch(/^[0-9a-f]{12}$/);
      expect(input.workRoot).not.toMatch(/control|P[1-5]|attempt|runs/);
      expect(input.resultsDir).toBe(join(outDir, "attempts", input.attemptId));
    }
  });

  test("each attempt's outcome.json is written by the sweep, void or not", async () => {
    // Act
    await sweep(async (input) => factsFor(input));
    const ids = await readdir(join(outDir, "attempts"));
    const outcomes = await Promise.all(
      ids.map(async (id) => JSON.parse(await readFile(join(outDir, "attempts", id, "outcome.json"), "utf8")) as RunOutcome),
    );

    // Assert
    expect(outcomes.map((o) => o.slotIndex).sort()).toEqual([0, 1]);
  });

  test("resume continues after the highest attempt, and an attempt without an outcome is a void", async () => {
    // Arrange: slot 0 had a void attempt 1 and an interrupted attempt 2
    await plantAttempt("aaaaaaaaaaa1", ORDER[0] as Slot, 1, ["timed-out"]);
    await plantAttempt("aaaaaaaaaaa2", ORDER[0] as Slot, 2, null);

    // Act
    const result = await sweep(async (input) => factsFor(input));

    // Assert
    expect(seen.map((i) => [i.slot.index, i.attempt])).toEqual([
      [0, 3],
      [1, 1],
    ]);
    expect(result.voidAttempts).toBe(2);
    expect(result.outcomes.some((o) => o.voids.includes("attempt-interrupted"))).toBe(true);
  });

  test("a slot already won is not re-run on resume", async () => {
    // Arrange
    await plantAttempt("bbbbbbbbbbb1", ORDER[0] as Slot, 1, []);

    // Act
    const result = await sweep(async (input) => factsFor(input));

    // Assert
    expect(seen.map((i) => i.slot.index)).toEqual([1]);
    expect(result.outcomes).toHaveLength(2);
  });

  test("the sixth void attempt aborts the sweep and every void is logged with its attempt", async () => {
    // Act
    const result = await sweep(async (input) => factsFor(input, ["service-failed-pre-turn"]));
    const log = (await readFile(join(outDir, "voids.jsonl"), "utf8")).trim().split("\n");

    // Assert
    expect(result.aborted).toBe(true);
    expect(result.voidAttempts).toBe(6);
    expect(seen).toHaveLength(6);
    expect(log).toHaveLength(6);
    expect(JSON.parse(log[5] ?? "{}")).toMatchObject({ slotIndex: 0, attempt: 6 });
  });

  test("A4: the account's usage limit pauses the sweep and costs none of the five voids", async () => {
    // Act — the very first attempt meets the limit
    const result = await sweep(async (input) => factsFor(input, ["usage-limit"]));
    const log = (await readFile(join(outDir, "voids.jsonl"), "utf8")).trim().split("\n");

    // Assert
    expect(seen).toHaveLength(1);
    expect(result.pausedForUsageLimit).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.voidAttempts).toBe(0);
    expect(JSON.parse(log[0] ?? "{}")).toMatchObject({ voids: ["usage-limit"] });
  });

  test("A4: a resume after the pause re-runs the slot, and the limit's void still counts nothing", async () => {
    // Arrange
    await plantAttempt("ddddddddddd1", ORDER[0] as Slot, 1, ["usage-limit"]);

    // Act
    const result = await sweep(async (input) => factsFor(input));

    // Assert
    expect(seen.map((i) => [i.slot.index, i.attempt])).toEqual([
      [0, 2],
      [1, 1],
    ]);
    expect(result.voidAttempts).toBe(0);
    expect(result.pausedForUsageLimit).toBe(false);
  });

  test("a resume already over the cap runs nothing and stays aborted", async () => {
    // Arrange
    for (let i = 1; i <= 6; i += 1) {
      await plantAttempt(`ccccccccccc${String(i)}`, ORDER[0] as Slot, i, ["timed-out"]);
    }

    // Act
    const result = await sweep(async (input) => factsFor(input));

    // Assert
    expect(seen).toHaveLength(0);
    expect(result.aborted).toBe(true);
  });

  test("a harness throw is a void attempt whose error is recorded", async () => {
    // Arrange
    let calls = 0;

    // Act
    await sweep(async (input) => {
      calls += 1;
      if (calls === 1) {
        throw new Error("hub did not start");
      }
      return factsFor(input);
    });
    const first = seen[0] as AttemptInput;
    const outcome = JSON.parse(
      await readFile(join(outDir, "attempts", first.attemptId, "outcome.json"), "utf8"),
    ) as Record<string, unknown>;
    const log = JSON.parse((await readFile(join(outDir, "voids.jsonl"), "utf8")).trim()) as Record<
      string,
      unknown
    >;

    // Assert
    expect(outcome["voids"]).toEqual(["harness-threw"]);
    expect(outcome["error"]).toBe("hub did not start");
    expect(log["error"]).toBe("hub did not start");
  });

  test("a void-log append that fails is not swallowed", async () => {
    // Arrange: voids.jsonl is a directory, so appending to it throws
    await mkdir(join(outDir, "voids.jsonl"));

    // Act / Assert
    expect(sweep(async (input) => factsFor(input, ["timed-out"]))).rejects.toThrow();
  });
});
