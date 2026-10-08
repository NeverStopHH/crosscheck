/**
 * A DEAD SESSION'S OWED RECHECKS ARE COUNTED WHEN ITS STATE IS REAPED (round
 * 3, F-M2). A session killed mid-turn never ran the turn-end recheck its 30 s
 * rests were owed, and no hook of it runs again: the debts would vanish with
 * the corpse. The reaper books them as `rest_unchecked` under the session's
 * own repo, dated when the newest rest began, and evicted debts with them.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm, utimes } from "node:fs/promises";

import { MAX_SPOOL_AGE_DAYS, MS_PER_DAY } from "../src/constants.ts";
import { repoKey, sessionStatePath } from "../src/config/paths.ts";
import { readCaptureLosses } from "../src/state/loss-ledger.ts";
import { reapStaleSessionStates } from "../src/state/session-reap.ts";
import { deriveSessionState, writeSessionState } from "../src/state/session-state.ts";
import { makeHome } from "./helpers.ts";

const REPO_ID = "github.com/acme/api";
const HUB_URL = "http://127.0.0.1:9";
const KEY = "dead-session";

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
});
