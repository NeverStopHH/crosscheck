/**
 * A DEAD SESSION'S OWED RECHECKS ARE COUNTED WHEN ITS STATE IS REAPED (round
 * 3, F-M2). A session killed mid-turn never ran the turn-end recheck its 30 s
 * rests were owed, and no hook of it runs again: the debts would vanish with
 * the corpse. The reaper books them as `rest_unchecked` under the session's
 * own repo, dated when the newest rest began, and evicted debts with them.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, rm, utimes } from "node:fs/promises";
import { dirname } from "node:path";

import { MAX_SPOOL_AGE_DAYS, MS_PER_DAY } from "../src/constants.ts";
import { repoKey, sessionStatePath } from "../src/config/paths.ts";
import { readCaptureLosses } from "../src/state/loss-ledger.ts";
import { readRestOmissions } from "../src/state/rest-omissions.ts";
import { reapStaleSessionStates } from "../src/state/session-reap.ts";
import { deriveSessionState, publishSessionState, readSessionState, writeSessionState } from "../src/state/session-state.ts";
import { makeHome } from "./helpers.ts";

const REPO_ID = "github.com/acme/api";
const HUB_URL = "http://127.0.0.1:9";
const OTHER_HUB_URL = "http://127.0.0.1:8";
const KEY = "dead-session";
/** No entry may be created or removed in a directory of this mode. */
const READ_ONLY_DIR_MODE = 0o500;
const OWNER_DIR_MODE = 0o700;

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

const NOW = new Date();
const DEAD_AT = new Date(NOW.getTime() - (MAX_SPOOL_AGE_DAYS + 1) * MS_PER_DAY);

/** A corpse past the reap age, owing what `owed` says. */
const corpse = async (label: string, owed: { readonly files: readonly string[]; readonly dropped?: number }): Promise<string> => {
  const home = await makeHome(label);
  homes.push(home);
  await writeSessionState(home, {
    ...deriveSessionState({
      hostSessionKey: KEY,
      repoId: REPO_ID,
      repoRoot: "/tmp/acme-api",
      hubUrl: HUB_URL,
      developerId: "dev_self",
      startedAt: DEAD_AT.toISOString(),
    }),
    tripwireCheckedFiles: owed.files.map((file, index) => ({ file, at: new Date(DEAD_AT.getTime() + index * 1_000).toISOString() })),
    ...(owed.dropped === undefined ? {} : { tripwireRestsDropped: owed.dropped }),
  });
  await utimes(sessionStatePath(home, KEY), DEAD_AT, DEAD_AT);
  return home;
};

describe("the reaper books a dead session's owed rechecks (round 3, F-M2)", () => {
  test("every debt and every evicted one, under the session's repo, dated at its newest rest", async () => {
    // Arrange
    const home = await corpse("reap-owed", { files: ["src/a.ts", "src/b.ts"], dropped: 1 });

    // Act
    const reaped = await reapStaleSessionStates(home, NOW);

    // Assert
    const losses = await readCaptureLosses(home, repoKey(HUB_URL, REPO_ID));
    expect(reaped).toBe(1);
    expect(losses.byKind["rest_unchecked"]).toBe(3);
    expect(losses.byDetail["rest_unchecked:reap"]).toBe(3);
    expect(losses.newestAt).toBe(new Date(DEAD_AT.getTime() + 1_000).toISOString());
  });

  test("a corpse that owed nothing books nothing", async () => {
    // Arrange
    const home = await corpse("reap-clean", { files: [] });

    // Act
    await reapStaleSessionStates(home, NOW);

    // Assert
    expect((await readCaptureLosses(home, repoKey(HUB_URL, REPO_ID))).total).toBe(0);
  });

  test("it books the local 'the person was not told' ledger too, as every hook does (review batch 2, L2)", async () => {
    // Arrange
    const home = await corpse("reap-omission", { files: ["src/a.ts", "src/b.ts"] });

    // Act
    await reapStaleSessionStates(home, NOW);

    // Assert: one booking, beside the two files of the capture-loss ledger.
    expect((await readRestOmissions(home, repoKey(HUB_URL, REPO_ID), NOW)).byReason.rest_unchecked).toBe(1);
  });

  test("a state that will not go is booked once, by the run that removes it (review batch 2, L3)", async () => {
    // Arrange: the sessions directory read-only, so the unlink fails.
    const home = await corpse("reap-stuck", { files: ["src/a.ts"] });
    const sessions = dirname(sessionStatePath(home, KEY));
    await chmod(sessions, READ_ONLY_DIR_MODE);

    // Act: two runs that cannot remove it, then one that can.
    let stuck: readonly number[] = [];
    try {
      stuck = [await reapStaleSessionStates(home, NOW), await reapStaleSessionStates(home, NOW)];
    } finally {
      await chmod(sessions, OWNER_DIR_MODE);
    }
    const bookedWhileStuck = (await readCaptureLosses(home, repoKey(HUB_URL, REPO_ID))).byKind["rest_unchecked"] ?? 0;
    const removed = await reapStaleSessionStates(home, NOW);

    // Assert
    expect(stuck).toEqual([0, 0]);
    expect(bookedWhileStuck).toBe(0);
    expect(removed).toBe(1);
    expect((await readCaptureLosses(home, repoKey(HUB_URL, REPO_ID))).byKind["rest_unchecked"]).toBe(1);
  });
});

describe("a SessionStart re-fire bound elsewhere books the rechecks it replaces (review batch 2, L4)", () => {
  test("a re-fire on another hub books the old binding's owed rechecks under the old repo", async () => {
    // Arrange: a live session owing two rechecks, on HUB_URL.
    const home = await makeHome("rebind-owed");
    homes.push(home);
    const live = deriveSessionState({
      hostSessionKey: KEY,
      repoId: REPO_ID,
      repoRoot: "/tmp/acme-api",
      hubUrl: HUB_URL,
      developerId: "dev_self",
      startedAt: NOW.toISOString(),
    });
    await writeSessionState(home, {
      ...live,
      tripwireCheckedFiles: [
        { file: "src/a.ts", at: NOW.toISOString() },
        { file: "src/b.ts", at: NOW.toISOString() },
      ],
    });

    // Act: the re-fire publishes the same host session bound to another hub.
    await publishSessionState(home, { ...live, hubUrl: OTHER_HUB_URL });

    // Assert: gone from the state, booked under the binding that owed them.
    expect((await readSessionState(home, KEY))?.tripwireCheckedFiles ?? []).toEqual([]);
    expect((await readCaptureLosses(home, repoKey(HUB_URL, REPO_ID))).byDetail["rest_unchecked:session-start"]).toBe(2);
    expect((await readCaptureLosses(home, repoKey(OTHER_HUB_URL, REPO_ID))).total).toBe(0);
  });
});
