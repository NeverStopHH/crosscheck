/**
 * THE COUNTER AND ITS EPOCH (spec 01 §3.3, §3.4) — the session state is the
 * only mechanism on this machine that can hand out a monotonic position, and
 * the two ways it silently restarts are what this file pins.
 *
 * SEQ-4, the re-fire carry. Claude Code fires SessionStart AGAIN inside a live
 * session on compact, resume and clear, and that fire RE-CREATES the state
 * file under the same hostSessionKey. Without the counter in
 * `withCarriedCapture`'s carried list the second half of a session restarts at
 * n = 0 under the SAME epoch, and two genuinely distinct events then share one
 * `(session, epoch, n)` — a duplicate position on the hot path, forever.
 *
 * SEQ-5's half of the same write. The counter may only be carried BESIDE its
 * epoch. Carrying one without the other is worse than carrying neither: a
 * fresh epoch beside a carried counter loses nothing, a carried epoch beside a
 * reset counter mints the duplicate above. #50 added three counters and did
 * NOT add them to that list, which is the exact omission this pins.
 */
import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { SEQ_EPOCH_PATTERN } from "@crosscheck/schema";

import {
  SESSION_STATE_LOCK_RETRIES,
  SPOOL_LOCK_RETRIES,
  SPOOL_LOCK_RETRY_DELAY_MS,
} from "../src/constants.ts";
import {
  allocateSeq,
  publishSessionState,
  readSessionState,
  sessionStateLockPath,
  writeSessionState,
} from "../src/state/session-state.ts";
import type { SessionStateInput } from "../src/state/session-state.ts";
import { sessionStatePath } from "../src/config/paths.ts";
import { registerSessionFlow } from "../src/flows/register-session.ts";
import { withLock } from "../src/spool/lock.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const ALLOCATIONS_PER_EMITTER = 100;
/**
 * Long enough that the spool's five attempts (5 x 20 ms) run out, short enough
 * that the session state's twenty do not. The test asserts both halves of that
 * sentence before it asserts anything about a position.
 */
const HOLD_MS = 200;
/** Long enough for the holder to be INSIDE the section, asserted rather than assumed. */
const HOLD_SETTLE_MS = 20;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const HOST_KEY = "seq-carry-uuid";
const REPO_ID = "github.com/acme/api";
const HUB_URL = "http://127.0.0.1:7901";
const EPOCH = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
/** Port 1 refuses instantly: an unreachable hub without the wait. */
const DEAD_HUB_URL = "http://127.0.0.1:1";

const stateInput = (
  overrides: Partial<SessionStateInput> = {},
): SessionStateInput => ({
  hostSessionKey: HOST_KEY,
  crosscheckSessionId: `cc_${HOST_KEY}`,
  workContextId: `wc_cc_${HOST_KEY}`,
  repoId: REPO_ID,
  repoRoot: "/tmp/repo",
  hubUrl: HUB_URL,
  developerId: "dev_self",
  startedAt: new Date().toISOString(),
  ...overrides,
});

describe("SEQ-4 — a re-fire must not restart the counter", () => {
  test("a re-fire of the same binding carries the counter and its epoch", async () => {
    // Arrange: a live session that has already handed out seven positions.
    const home = await makeHome("seq-carry");
    try {
      await writeSessionState(
        home,
        stateInput({ seqEpoch: EPOCH, eventSeq: 7 }),
      );

      // Act: compact fires SessionStart again — same repo, same hub, a state
      // input that knows nothing about the counter and mints its own epoch.
      await publishSessionState(
        home,
        stateInput({
          seqEpoch: "11111111-2222-4333-8444-555555555555",
          eventSeq: 0,
        }),
      );

      // Assert
      const after = await readSessionState(home, HOST_KEY);
      expect(after?.eventSeq).toBe(7);
      expect(after?.seqEpoch).toBe(EPOCH);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a re-fire bound elsewhere keeps the new fire's own epoch and counter", async () => {
    // Arrange: a state file bound to ANOTHER repo is another session's, and
    // the first-wins rule decides those — carrying its counter would splice
    // two sessions' orders into one.
    const home = await makeHome("seq-carry-foreign");
    try {
      await writeSessionState(
        home,
        stateInput({
          repoId: "github.com/acme/other",
          seqEpoch: EPOCH,
          eventSeq: 7,
        }),
      );

      // Act
      await publishSessionState(
        home,
        stateInput({
          seqEpoch: "11111111-2222-4333-8444-555555555555",
          eventSeq: 0,
        }),
      );

      // Assert
      const after = await readSessionState(home, HOST_KEY);
      expect(after?.eventSeq).toBe(0);
      expect(after?.seqEpoch).toBe("11111111-2222-4333-8444-555555555555");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a state file written before this field parses with no position at all", async () => {
    // Arrange: §4 — state files written before this lands parse unchanged and
    // mint an epoch on their next CREATE. A null epoch is not a bug, it is a
    // session whose records honestly carry no position.
    const home = await makeHome("seq-legacy");
    try {
      await writeSessionState(home, stateInput());

      // Assert
      const after = await readSessionState(home, HOST_KEY);
      expect(after?.seqEpoch).toBeNull();
      expect(after?.eventSeq).toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("SEQ-3 — two emitters on one session cannot take one position", () => {
  /**
   * WHAT THIS TEST MAY ASSERT, and what the test it replaces could not.
   *
   * It used to drop every refused allocation on the floor (`if (range !== null)`)
   * and then assert 200 positions came back. That is a LIVENESS claim wearing a
   * safety claim's name: it passes or fails on how busy the machine is, and it
   * reports the failure as `Expected length: 200, Received length: 199` — a
   * sentence naming neither the lock nor the refusal. It was green on every
   * developer Mac and red on both CI runners for exactly that reason.
   *
   * Safety is what holds at ANY load, so safety is what is asserted here: no two
   * emitters share a position, none is reused, and the counter moved by exactly
   * the number of positions actually handed out. A refusal is legal — capture/
   * seq.ts makes it a first-class value — and it is COUNTED here rather than
   * hidden, so a regression that starts refusing surfaces as a number a reader
   * can act on. That the count is near zero in practice is the PATIENCE claim,
   * pinned deterministically by the busy-lock test below instead of being hoped
   * for from the scheduler.
   */
  test("interleaved allocations never share, reuse or lose a position", async () => {
    // Arrange: the shape of connector-claude/test/state-race.test.ts —
    // MONOTONICITY IS A PROPERTY OF THE LOCK, not of the caller, so the test
    // that matters runs many allocators at once and asks for a set, not an
    // order of arrival.
    const home = await makeHome("seq-race");
    try {
      await writeSessionState(home, stateInput({ seqEpoch: EPOCH }));

      // Act: two emitters, a hundred allocations each, all overlapping.
      const emitter = async (): Promise<{
        readonly taken: readonly number[];
        readonly refused: number;
      }> => {
        const taken: number[] = [];
        let refused = 0;
        for (let index = 0; index < ALLOCATIONS_PER_EMITTER; index += 1) {
          const range = await allocateSeq(home, HOST_KEY, 1);
          if (range === null) {
            refused += 1;
          } else {
            taken.push(range.from);
          }
        }
        return { taken, refused };
      };
      const [left, right] = await Promise.all([emitter(), emitter()]);
      const all = [...left.taken, ...right.taken].sort((a, b) => a - b);
      const refused = left.refused + right.refused;
      const asked = 2 * ALLOCATIONS_PER_EMITTER;

      // Assert: every position handed out is distinct, the run is contiguous
      // from 1 — n = 0 belongs to session.started and is never allocated again
      // — and NOTHING vanished: granted plus refused is everything asked for.
      if (refused > 0) {
        console.log(
          `[seq-race] ${String(refused)}/${String(asked)} allocations refused` +
            " (a busy lock is legal; see SESSION_STATE_LOCK_RETRIES)",
        );
      }
      expect(all.length + refused).toBe(asked);
      expect(new Set(all).size).toBe(all.length);
      expect(all[0]).toBe(1);
      expect(all.at(-1)).toBe(all.length);
      // The counter is the ledger: it moved by exactly what was handed out, so
      // a refusal consumed nothing and no position was minted twice.
      const state = await readSessionState(home, HOST_KEY);
      expect(state?.eventSeq).toBe(all.length);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  /**
   * THE PATIENCE, pinned without a stopwatch race.
   *
   * SEQ-3's real failure was never two emitters taking one position — the
   * counter always equalled "asked minus refused", so mutual exclusion held. It
   * was an emitter running OUT OF ATTEMPTS: `withLock`'s default retry count is
   * sized by what a busy FLUSH costs, and spec 01 put the causal order on the
   * same primitive, where that same failure costs a position instead.
   *
   * So this holds the lock for longer than the spool's patience and shorter than
   * the session state's, and asks for a position underneath it. The holder is
   * THIS process, which is what makes the wait deterministic rather than
   * scheduler-dependent: `stealableToken` refuses a claim younger than
   * SPOOL_LOCK_STALE_MS, and refuses it again because the holding pid is running
   * and is not a zombie — so nothing can shorten the wait, on any machine, at
   * any load.
   */
  test("a lock held past the spool's patience costs no position", async () => {
    // Arrange
    const home = await makeHome("seq-busy-lock");
    try {
      await writeSessionState(home, stateInput({ seqEpoch: EPOCH }));
      const spoolPatienceMs = SPOOL_LOCK_RETRIES * SPOOL_LOCK_RETRY_DELAY_MS;
      const statePatienceMs =
        SESSION_STATE_LOCK_RETRIES * SPOOL_LOCK_RETRY_DELAY_MS;
      // The precondition is ARITHMETIC, and asserted before the behaviour: if
      // these ever stop straddling HOLD_MS, the assertion below proves nothing.
      expect(spoolPatienceMs).toBeLessThan(HOLD_MS);
      expect(statePatienceMs).toBeGreaterThan(HOLD_MS + HOLD_SETTLE_MS);

      // Act: take the state's own lock and sit in it, then allocate underneath.
      let held = false;
      const holder = withLock(
        sessionStateLockPath(home, HOST_KEY),
        null,
        async () => {
          held = true;
          await delay(HOLD_MS);
          return null;
        },
      );
      await delay(HOLD_SETTLE_MS);
      expect(held).toBe(true);
      const range = await allocateSeq(home, HOST_KEY, 1);
      await holder;

      // Assert: the position was waited for, not refused. At the spool's five
      // attempts this is null, and the record that would have carried it goes
      // out stamped `allocation_failed` instead.
      expect(range).not.toBeNull();
      expect(range?.from).toBe(1);
      expect((await readSessionState(home, HOST_KEY))?.eventSeq).toBe(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a range of many hands back consecutive positions and moves the counter once", async () => {
    // Arrange: the hook path pre-allocates a WORST-CASE range once rather than
    // paying a lock per record — gaps inside it are legal (§3.4).
    const home = await makeHome("seq-range");
    try {
      await writeSessionState(home, stateInput({ seqEpoch: EPOCH }));

      // Act
      const first = await allocateSeq(home, HOST_KEY, 21);
      const second = await allocateSeq(home, HOST_KEY, 1);

      // Assert
      expect(first).toEqual({ epoch: EPOCH, from: 1, count: 21 });
      expect(second).toEqual({ epoch: EPOCH, from: 22, count: 1 });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a session with no epoch yet refuses the position rather than inventing one", async () => {
    // Arrange: a state file written before this protocol field. Allocating
    // under a null epoch would produce positions nothing can compare and
    // nothing can tell apart from another home's.
    const home = await makeHome("seq-no-epoch");
    try {
      await writeSessionState(home, stateInput());

      // Act
      const range = await allocateSeq(home, HOST_KEY, 1);

      // Assert
      expect(range).toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a deleted state file refuses rather than throwing on the hook path", async () => {
    // Arrange: a detached worker can outlive SessionEnd, whose state delete
    // removes the file underneath it. Fail-open like every state write on a
    // hook path — the record still lands, carrying `allocation_failed`.
    const home = await makeHome("seq-no-state");
    try {
      // Act
      const range = await allocateSeq(home, HOST_KEY, 1);

      // Assert
      expect(range).toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("SEQ-5 — a busy lock must mint a new epoch, never restart the old one", () => {
  test("registration mints the epoch onto the state INPUT", async () => {
    // Arrange: the epoch cannot be minted inside publishSessionState, because
    // the BUSY-LOCK FALLBACK never runs that code — it writes the caller's
    // plain state, "the counters lose rather than the file". Minting on the
    // input is what makes that fallback write a FRESH epoch beside eventSeq 0
    // instead of a null one, and a fresh epoch is merely not comparable where
    // a null one is not sequenced at all.
    const home = await makeHome("seq-register");
    const repo = await makeRepo("seq-register", {
      remote: "git@github.com:acme/api.git",
    });
    try {
      // Act: an unreachable hub — registration fails, state is still published.
      await registerSessionFlow({
        home,
        repoKey: "k",
        hub: {
          hubUrl: DEAD_HUB_URL,
          apiKey: "k",
          timeoutMs: 500,
          home,
          repoKey: "k",
          now: () => new Date(),
        },
        agentKind: "claude-code",
        hostSessionKey: HOST_KEY,
        repoId: REPO_ID,
        repoRoot: repo,
        branch: "main",
        baseCommit: "0".repeat(40),
        hubUrl: DEAD_HUB_URL,
        fallbackDeveloperId: "dev_self",
        title: "main @ api",
        status: "analyzing",
        now: new Date(),
      });

      // Assert
      const state = await readSessionState(home, HOST_KEY);
      expect(state?.seqEpoch).toMatch(SEQ_EPOCH_PATTERN);
      expect(state?.eventSeq).toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("a busy lock writes a fresh epoch rather than a session with none", async () => {
    // Arrange: hold the state lock, so publishSessionState takes its uncarried
    // fallback exactly as it does when a sibling hook is mid-write.
    const home = await makeHome("seq-busy");
    try {
      await writeSessionState(
        home,
        stateInput({ seqEpoch: EPOCH, eventSeq: 9 }),
      );
      const fresh = crypto.randomUUID();

      // Act
      await withLock(
        `${sessionStatePath(home, HOST_KEY)}.lock`,
        false,
        async () => {
          await publishSessionState(
            home,
            stateInput({ seqEpoch: fresh, eventSeq: 0 }),
          );
          return true;
        },
      );

      // Assert: the counter lost, as the fallback's header says it must — but
      // under a DIFFERENT epoch, so the two halves are not comparable rather
      // than sharing positions.
      const after = await readSessionState(home, HOST_KEY);
      expect(after?.eventSeq).toBe(0);
      expect(after?.seqEpoch).toBe(fresh);
      expect(after?.seqEpoch).not.toBe(EPOCH);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
