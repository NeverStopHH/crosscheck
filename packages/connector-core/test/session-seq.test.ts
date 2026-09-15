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

import {
  publishSessionState,
  readSessionState,
  writeSessionState,
} from "../src/state/session-state.ts";
import type { SessionStateInput } from "../src/state/session-state.ts";
import { makeHome } from "./helpers.ts";

const HOST_KEY = "seq-carry-uuid";
const REPO_ID = "github.com/acme/api";
const HUB_URL = "http://127.0.0.1:7901";
const EPOCH = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

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
