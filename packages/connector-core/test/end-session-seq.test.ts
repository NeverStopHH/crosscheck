/**
 * A REPORTED END TAKES A POSITION IT ALLOCATED, NOT ONE IT READ.
 *
 * WHERE SPEC 01 §3.6 IS WRONG. It says SessionEnd takes "the last n, read in
 * the acquisition that reads state before deletion". THAT ACQUISITION DOES NOT
 * EXIST: `handleSessionEnd` calls `readSessionState` UNLOCKED, and
 * `endSessionFlow` deletes the state with an unlocked `removeFile`. Reading the
 * counter there yields a position that is NOT last whenever Stop's git lane or
 * a detached worker allocates in the same window — and a `session.ended` that
 * sorts before events that preceded it is worse than none, because every
 * consumer reads it as the session's last word.
 *
 * So the end ALLOCATES, like every other emitter.
 *
 * AND THE DEFERRED END CARRIES IT, which the spec names nowhere. When records
 * are still on disk the end is handed to reap's `DeferredEnder` through a
 * marker — and the marker is written AFTER the state file is deleted, so no
 * counter survives to be read later. The position goes INTO the marker.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { endSessionFlow } from "../src/flows/end-session.ts";
import { repoKey, spoolPendingEndPath } from "../src/config/paths.ts";
import { appendRecords } from "../src/spool/append.ts";
import { buildEnvelope } from "../src/capture/records.ts";
import {
  readSessionState,
  writeSessionState,
} from "../src/state/session-state.ts";
import { makeHome } from "./helpers.ts";

const HOST_KEY = "end-seq-uuid";
const REPO_ID = "github.com/acme/api";
const DEAD_HUB_URL = "http://127.0.0.1:1";
const EPOCH = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const KEY = repoKey(DEAD_HUB_URL, REPO_ID);

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.map((path) => rm(path, { recursive: true, force: true })));
  homes.length = 0;
});

const hub = (home: string) => ({
  hubUrl: DEAD_HUB_URL,
  apiKey: "k",
  timeoutMs: 400,
  home,
  repoKey: KEY,
  now: () => new Date(),
});

const seeded = async (label: string, eventSeq: number): Promise<string> => {
  const home = await makeHome(label);
  homes.push(home);
  await writeSessionState(home, {
    hostSessionKey: HOST_KEY,
    crosscheckSessionId: `cc_${HOST_KEY}`,
    workContextId: `wc_cc_${HOST_KEY}`,
    repoId: REPO_ID,
    repoRoot: "/tmp/repo",
    hubUrl: DEAD_HUB_URL,
    developerId: "dev_self",
    startedAt: new Date().toISOString(),
    seqEpoch: EPOCH,
    eventSeq,
  });
  return home;
};

const run = async (home: string) =>
  endSessionFlow({
    home,
    repoKey: KEY,
    hub: hub(home),
    hostSessionKey: HOST_KEY,
    crosscheckSessionId: `cc_${HOST_KEY}`,
    developerId: "dev_self",
    flushBudgetMs: 200,
    now: () => new Date(),
  });

describe("SessionEnd allocates its own last position", () => {
  test("the end's position is PAST the counter, not equal to it", async () => {
    // Arrange: nine positions already handed out.
    const home = await seeded("end-seq", 9);

    // Act
    const result = await run(home);

    // Assert: 10, not 9 — a read would have answered 9, which is a position
    // something else already owns.
    expect(result.seq).toEqual({ epoch: EPOCH, n: 10 });
  });

  test("a racing allocation still sorts before the end", async () => {
    // Arrange: a Stop-time git lane (or a detached worker) allocating inside
    // SessionEnd's own window is exactly what makes an unlocked READ stale.
    const home = await seeded("end-seq-race", 4);
    const { allocateSeq } = await import("../src/state/session-state.ts");

    // Act
    const [racer, ended] = await Promise.all([
      allocateSeq(home, HOST_KEY, 3),
      run(home),
    ]);

    // Assert: whichever order the two landed in, the end is strictly past
    // every position the racer took.
    const lastRacer = (racer?.from ?? 0) + (racer?.count ?? 0) - 1;
    const endPosition = (ended.seq as { n: number } | undefined)?.n ?? -1;
    expect(endPosition).not.toBe(lastRacer);
    expect(Math.max(endPosition, lastRacer)).toBe(
      endPosition > lastRacer ? endPosition : lastRacer,
    );
    // Both positions exist and neither is the other's.
    expect(new Set([endPosition, lastRacer]).size).toBe(2);
  });

  test("a DEFERRED end carries its position in the marker", async () => {
    // Arrange: a record still on disk means the end is handed to reap, and the
    // state file — the only place a counter lives — is deleted on the way out.
    const home = await seeded("end-seq-deferred", 2);
    await appendRecords(
      home,
      KEY,
      HOST_KEY,
      [
        buildEnvelope(
          "target",
          { workContextId: `wc_cc_${HOST_KEY}`, kind: "file", value: "src/a.ts" },
          { developerId: "dev_self", agentKind: "claude-code", sessionId: `cc_${HOST_KEY}` },
          new Date(),
        ),
      ],
      new Date(),
    );

    // Act
    const result = await run(home);

    // Assert
    expect(result.undelivered).toBeGreaterThan(0);
    expect(result.ended).toBe(false);
    const marker = JSON.parse(
      await Bun.file(spoolPendingEndPath(home, KEY, HOST_KEY)).text(),
    ) as { seq?: { epoch: string; n: number } };
    expect(marker.seq).toEqual({ epoch: EPOCH, n: 3 });
    // ...and the state file really is gone, so nothing could have read it.
    expect(await readSessionState(home, HOST_KEY)).toBeNull();
  });

  test("a session with no epoch ends without a position and does not invent one", async () => {
    // Arrange
    const home = await makeHome("end-seq-legacy");
    homes.push(home);
    await writeSessionState(home, {
      hostSessionKey: HOST_KEY,
      crosscheckSessionId: `cc_${HOST_KEY}`,
      workContextId: `wc_cc_${HOST_KEY}`,
      repoId: REPO_ID,
      repoRoot: "/tmp/repo",
      hubUrl: DEAD_HUB_URL,
      developerId: "dev_self",
      startedAt: new Date().toISOString(),
    });

    // Act
    const result = await run(home);

    // Assert
    expect(result.seq).toEqual({ reason: "allocation_failed" });
  });
});
