/**
 * THE COLLISION RECORD IN SESSION STATE IS READ ENTRY BY ENTRY (review of
 * feat/collision-visible, L7 and M3). The state file is shared by every hook
 * of a session; a malformed `collisionNotices` or `collisionRelayQueue` — an
 * older writer, a hand edit, a torn write — must cost only the bad entries,
 * never the state (a null state silences every hook of the session) and never
 * the good entries beside them.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";

import { sessionStatePath } from "../src/config/paths.ts";
import {
  deriveSessionState,
  readSessionState,
  writeSessionState,
} from "../src/state/session-state.ts";
import { makeHome } from "./helpers.ts";

const KEY = "collision-state";
const VALID_KEY = JSON.stringify(["dev_mike", "wc_mike"]);
const VALID_NOTICE = {
  key: VALID_KEY,
  developerId: "dev_mike",
  name: "Mike",
  files: ["src/a.ts"],
  fileCount: 1,
  branch: null,
  lastActiveAt: null,
};

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })));
  homes.length = 0;
});

/** A state file with `fields` written over it raw, then read back through the schema. */
const readWith = async (fields: Record<string, unknown>) => {
  const home = await makeHome("collision-state");
  homes.push(home);
  await writeSessionState(
    home,
    deriveSessionState({
      hostSessionKey: KEY,
      repoId: "github.com/acme/api",
      repoRoot: "/tmp/repo",
      hubUrl: "http://hub.invalid",
      developerId: "dev_self",
      startedAt: "2026-10-07T10:00:00.000Z",
    }),
  );
  const path = sessionStatePath(home, KEY);
  const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  await writeFile(path, JSON.stringify({ ...raw, ...fields }));
  return readSessionState(home, KEY);
};

describe("the told groups are read entry by entry", () => {
  test.each([
    ["garbage", "garbage"],
    ["null", null],
    ["an object", {}],
    ["a number", 42],
  ] as const)("notices that are %s read as none, and the state survives", async (_label, value) => {
    // Act
    const state = await readWith({ collisionNotices: value });

    // Assert
    expect(state).not.toBeNull();
    expect(state?.repoId).toBe("github.com/acme/api");
    expect(state?.collisionNotices ?? []).toEqual([]);
  });

  test("a mixed list keeps every valid group and drops the rest", async () => {
    // Arrange: a number, an empty key, a file list with an empty path, a valid group
    const mixed = [42, { key: "" }, { ...VALID_NOTICE, files: [""] }, VALID_NOTICE, null];

    // Act
    const state = await readWith({ collisionNotices: mixed });

    // Assert
    expect(state?.collisionNotices).toEqual([VALID_NOTICE]);
  });

  test("a valid queue beside broken notices is kept", async () => {
    // Act
    const state = await readWith({ collisionNotices: "garbage", collisionRelayQueue: [VALID_KEY] });

    // Assert
    expect(state?.collisionRelayQueue).toEqual([VALID_KEY]);
  });
});

describe("the relay queue is read entry by entry", () => {
  test.each([
    ["garbage", "garbage"],
    ["null", null],
    ["a number", 42],
  ] as const)("a queue that is %s reads as none, and the state survives", async (_label, value) => {
    // Act
    const state = await readWith({ collisionRelayQueue: value });

    // Assert
    expect(state).not.toBeNull();
    expect(state?.collisionRelayQueue ?? []).toEqual([]);
  });

  test("a mixed queue keeps its valid keys and drops the rest", async () => {
    // Act
    const state = await readWith({ collisionRelayQueue: [VALID_KEY, 7, "", null, { key: VALID_KEY }] });

    // Assert
    expect(state).not.toBeNull();
    expect(state?.collisionRelayQueue).toEqual([VALID_KEY]);
  });

  test("a queue that is not a list reads as none, and the state survives", async () => {
    // Act
    const state = await readWith({ collisionRelayQueue: { a: 1 } });

    // Assert
    expect(state?.repoId).toBe("github.com/acme/api");
    expect(state?.collisionRelayQueue ?? []).toEqual([]);
  });

  test("a valid notice beside a broken queue is kept", async () => {
    // Act
    const state = await readWith({ collisionRelayQueue: "garbage", collisionNotices: [VALID_NOTICE] });

    // Assert
    expect(state?.collisionNotices).toEqual([VALID_NOTICE]);
  });
});
