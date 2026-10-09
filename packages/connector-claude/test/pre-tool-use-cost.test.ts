/**
 * WHAT A PreToolUse SPAWNS (batch-2 integration review, M6). Under load, each
 * git process on the hook's path was 30–300 ms of an 800 ms budget. The edit's
 * classification asks `check-attr` once per new path, so it now asks about
 * the file's directory in the same call: the next edit beside it is a cache
 * hit, and spawns no `check-attr` at all.
 *
 * Spawns are counted in-process by wrapping Bun.spawn while the hook runs.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { runHook } from "../src/index.ts";
import {
  BEHAVIOUR_TIMING,
  OVERLAP_FILE,
  SECOND_FILE,
  cleanupCollisionFixtures,
  collisionFixture,
  editPayload,
} from "./fixtures/collision-fixture.ts";

afterEach(cleanupCollisionFixtures);

const realSpawn = Bun.spawn;

afterEach(() => {
  Bun.spawn = realSpawn;
});

/** The git subcommand of an argv, past `git` and its `-c key=value` pins. */
const subcommandOf = (argv: readonly string[]): string => {
  const at = argv.findIndex((part, index) => index > 0 && !part.startsWith("-") && argv[index - 1] !== "-c");
  return at === -1 ? "?" : (argv[at] ?? "?");
};

/** Every git subcommand this process spawns while `work` runs. */
const gitSpawnedBy = async (work: () => Promise<unknown>): Promise<readonly string[]> => {
  const asked: string[] = [];
  Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
    const [first] = args;
    const cmd: readonly string[] = Array.isArray(first) ? first : ((first as { readonly cmd?: readonly string[] }).cmd ?? []);
    if (cmd[0] === "git") {
      asked.push(subcommandOf(cmd));
    }
    return realSpawn(...args);
  }) as typeof Bun.spawn;
  try {
    await work();
    return asked;
  } finally {
    Bun.spawn = realSpawn;
  }
};

describe("an edit's classification", () => {
  test("an edit beside one already classified spawns no check-attr: the first asked about its directory", async () => {
    // Arrange: src/auth/refresh.ts and src/auth/rotate.ts are neighbours
    const fix = await collisionFixture("ptc-neighbours", BEHAVIOUR_TIMING);
    const first = await gitSpawnedBy(() => runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE), fix.env));

    // Act
    const beside = await gitSpawnedBy(() => runHook("pre-tool-use", editPayload(fix.repo, SECOND_FILE), fix.env));

    // Assert
    expect(first.filter((sub) => sub === "check-attr")).toEqual(["check-attr"]);
    expect(beside.filter((sub) => sub === "check-attr")).toEqual([]);
  });
});
