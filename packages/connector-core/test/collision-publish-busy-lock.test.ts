/**
 * A COMPACT UNDER A BUSY LOCK KEEPS WHO WAS TOLD AND WHAT IS QUEUED (review
 * of feat/collision-visible, round 3, F-L5). SessionStart re-fires inside a
 * live session on compact and resume, and its publication carries the
 * session's facts across under the state lock — but a lock that stays busy
 * fell back to a plain write of the fresh state, without them. Probe r3b B4,
 * the lock held 2.5 s: the relay queue went from 1 to 0 and the told-record
 * from 1 to 0, so a subagent's hit waiting for the main thread was never
 * said, and a ghost row already told was told again.
 *
 * The fallback now carries the collision fields from a best-effort unlocked
 * read. The sequence pair and the other counters stay where they were: an
 * unlocked read of a counter a lock holder is advancing could hand out a
 * position twice, and a queue told twice is the safe side of that trade.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { collisionKey, tripwireCollision } from "../src/hints/collision-notice.ts";
import { withLock } from "../src/spool/lock.ts";
import {
  deriveSessionState,
  publishSessionState,
  readSessionState,
  sessionStateLockPath,
  updateSessionState,
  withCollisionNotices,
  withQueuedCollisionRelays,
  writeSessionState,
} from "../src/state/session-state.ts";
import { makeHome } from "./helpers.ts";

const KEY = "busy-lock-session";
const REPO_ID = "github.com/acme/api";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

const stateFor = (repoId: string): ReturnType<typeof deriveSessionState> =>
  deriveSessionState({
    hostSessionKey: KEY,
    repoId,
    repoRoot: "/tmp/acme-api",
    hubUrl: "http://127.0.0.1:9",
    developerId: "dev_self",
    startedAt: new Date().toISOString(),
  });

const nick = tripwireCollision(
  {
    sessionId: "cc_nick",
    developerId: "dev_nick",
    developerName: "Nick",
    branch: "feat/refresh-fix",
    status: "implementing",
    lastHeartbeatAt: new Date().toISOString(),
    workContextId: "wc_nick",
    workContextTitle: "t",
  },
  "src/auth/refresh.ts",
);

/** A live session whose record holds Nick, told and still queued for the main thread. */
const liveSession = async (label: string): Promise<string> => {
  const home = await makeHome(label);
  homes.push(home);
  await writeSessionState(home, stateFor(REPO_ID));
  await updateSessionState(home, KEY, (fresh) =>
    withCollisionNotices(withQueuedCollisionRelays(fresh, [nick.key]), [nick]),
  );
  return home;
};

/** Runs `act` while another holder keeps the state lock for its whole length. */
const whileLockIsHeld = async (home: string, act: () => Promise<void>): Promise<void> => {
  const release: { value: () => void } = { value: () => undefined };
  const gate = new Promise<void>((done) => {
    release.value = done;
  });
  const acquired: { value: () => void } = { value: () => undefined };
  const isHeld = new Promise<void>((done) => {
    acquired.value = done;
  });
  const holder = withLock(sessionStateLockPath(home, KEY), false, async () => {
    acquired.value();
    await gate;
    return true;
  });
  await isHeld;
  try {
    await act();
  } finally {
    release.value();
    await holder;
  }
};

describe("a SessionStart publication under a busy state lock (round 3, F-L5)", () => {
  test("keeps the relay queue and the record of who was told", async () => {
    // Arrange
    const home = await liveSession("pub-busy");

    // Act: the compact's re-fire publishes while the lock never frees
    await whileLockIsHeld(home, () => publishSessionState(home, stateFor(REPO_ID)));

    // Assert
    const after = await readSessionState(home, KEY);
    expect(after?.collisionRelayQueue).toEqual([nick.key]);
    expect(after?.collisionNotices?.map((group) => group.key)).toEqual([collisionKey("dev_nick", "wc_nick")]);
  });

  test("carries the drop tally the next drain owns up to", async () => {
    // Arrange
    const home = await liveSession("pub-busy-dropped");
    await updateSessionState(home, KEY, (fresh) => ({ ...fresh, collisionRelayDropped: 3 }));

    // Act
    await whileLockIsHeld(home, () => publishSessionState(home, stateFor(REPO_ID)));

    // Assert
    expect((await readSessionState(home, KEY))?.collisionRelayDropped).toBe(3);
  });

  test("carries nothing from a state file bound to another repo", async () => {
    // Arrange
    const home = await liveSession("pub-busy-elsewhere");

    // Act: a re-fire for a different repo under the same host key
    await whileLockIsHeld(home, () => publishSessionState(home, stateFor("github.com/acme/other")));

    // Assert
    const after = await readSessionState(home, KEY);
    expect(after?.repoId).toBe("github.com/acme/other");
    expect(after?.collisionRelayQueue).toBeUndefined();
    expect(after?.collisionNotices).toBeUndefined();
  });

  test("leaves the sequence pair to the fresh state, as before: an unlocked read is no basis for positions", async () => {
    // Arrange: positions this session already handed out
    const home = await liveSession("pub-busy-seq");
    await updateSessionState(home, KEY, (fresh) => ({ ...fresh, eventSeq: 40 }));
    const incoming = stateFor(REPO_ID);

    // Act
    await whileLockIsHeld(home, () => publishSessionState(home, incoming));

    // Assert
    const after = await readSessionState(home, KEY);
    expect(after?.eventSeq).toBe(incoming.eventSeq);
    expect(after?.seqEpoch).toBe(incoming.seqEpoch);
  });
});
