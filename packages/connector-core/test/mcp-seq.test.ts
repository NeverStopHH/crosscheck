/**
 * D1 — AN AMBIGUOUS SESSION REFUSES THE POSITION, NOT THE RECORD.
 *
 * An MCP server is never told which session is calling it, so `mcp/session.ts`
 * PICKS: same hub, same repo, prefer the same worktree root, then newest. Its
 * own header states the limit — two agent sessions in the SAME worktree
 * against the same hub are indistinguishable from in here, and the newest one
 * is chosen. `set_intent` is exactly the call AT-4 hangs on, so a wrong guess
 * files an amendment into ANOTHER session's causal order and lets the answer
 * come out of a coin flip with full confidence.
 *
 * So the ambiguity is COUNTED and the position is withheld: the claim or the
 * intent still lands, carrying `allocation_failed`, and `doctor` says how many
 * worktrees on this machine are in that state and what to do about it.
 *
 * THE COST, chosen rather than discovered: in a two-agent worktree
 * explanation_timing is unavailable until the host passes a session id to MCP
 * servers. That is strictly better than an answer that is right half the time.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { seqAt } from "../src/capture/seq.ts";
import type { McpContext } from "../src/mcp/context.ts";
import { resolveOwnWorkContext } from "../src/mcp/session.ts";
import { allocateToolSeq } from "../src/mcp/tools/shared.ts";
import { writeSessionState } from "../src/state/session-state.ts";
import { summarizeSeqCost, formatSeqCost, seqWarning } from "../src/state/seq-cost.ts";
import type { SessionState } from "../src/state/session-state.ts";
import type { RepoIdentity } from "../src/git/repo-identity.ts";
import { makeHome } from "./helpers.ts";

const HUB = "http://127.0.0.1:9999";
const REPO_ID = "github.com/acme/api";
const ROOT = "/tmp/acme-api";
const OTHER_ROOT = "/tmp/acme-api-worktree";
const EPOCH = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

const homes: string[] = [];

afterAll(async () => {
  await Promise.all(homes.map((path) => rm(path, { recursive: true, force: true })));
});

const newHome = async (label: string): Promise<string> => {
  const home = await makeHome(label);
  homes.push(home);
  return home;
};

const identity = (root: string = ROOT): RepoIdentity => ({
  repoId: REPO_ID,
  root,
  branch: "main",
  baseCommit: "a1b2c3d4",
});

const seed = async (
  home: string,
  key: string,
  startedAt: string,
  repoRoot: string = ROOT,
): Promise<void> => {
  await writeSessionState(home, {
    hostSessionKey: key,
    crosscheckSessionId: `cc_${key}`,
    workContextId: `wc_cc_${key}`,
    repoId: REPO_ID,
    repoRoot,
    hubUrl: HUB,
    developerId: "dev_nick",
    startedAt,
    lastHeartbeatAt: startedAt,
    seqEpoch: EPOCH,
    eventSeq: 3,
  });
};

const stateOf = (overrides: Partial<SessionState>): SessionState =>
  ({
    hostSessionKey: "k",
    repoId: REPO_ID,
    repoRoot: ROOT,
    hubUrl: HUB,
    seqEpoch: null,
    eventSeq: 0,
    // The schema defaults this to 0 for every state a reader ever sees; the
    // cast below is what lets a fixture omit it, so the default is restated
    // here rather than defended against in `summarizeSeqCost`, where a `?? 0`
    // would hide a field that really had gone missing.
    toolWindowEvictions: 0,
    toolWindowMisses: 0,
    ...overrides,
  }) as SessionState;

describe("the picker says when it guessed", () => {
  test("one session in the worktree is not ambiguous", async () => {
    // Arrange
    const home = await newHome("mcp-seq-one");
    await seed(home, "only-uuid", "2026-07-24T09:00:00.000Z");

    // Act
    const own = await resolveOwnWorkContext(home, identity(), HUB);

    // Assert
    expect(own?.sessionAmbiguous).toBe(false);
  });

  test("two sessions in ONE worktree is ambiguous — the newest is a coin flip", async () => {
    // Arrange
    const home = await newHome("mcp-seq-two");
    await seed(home, "older-uuid", "2026-07-24T09:00:00.000Z");
    await seed(home, "newer-uuid", "2026-07-24T11:00:00.000Z");

    // Act
    const own = await resolveOwnWorkContext(home, identity(), HUB);

    // Assert: the record still resolves — only the CONFIDENCE is withdrawn.
    expect(own?.crosscheckSessionId).toBe("cc_newer-uuid");
    expect(own?.sessionAmbiguous).toBe(true);
  });

  test("a session in ANOTHER worktree of the same repo is not ambiguous", async () => {
    // Arrange: the root is what separates two genuinely different pieces of
    // work on one repo, and the picker prefers it over recency for that
    // reason. A sibling worktree is the ORDINARY case, not the exception.
    const home = await newHome("mcp-seq-sibling");
    await seed(home, "here-uuid", "2026-07-24T09:00:00.000Z", ROOT);
    await seed(home, "there-uuid", "2026-07-24T11:00:00.000Z", OTHER_ROOT);

    // Act
    const own = await resolveOwnWorkContext(home, identity(), HUB);

    // Assert
    expect(own?.crosscheckSessionId).toBe("cc_here-uuid");
    expect(own?.sessionAmbiguous).toBe(false);
  });

  test("two sessions and NO root match at all is ambiguous", async () => {
    // Arrange: the picker falls through to newest-started, which is a guess
    // between two strangers rather than a preference.
    const home = await newHome("mcp-seq-noroot");
    await seed(home, "a-uuid", "2026-07-24T09:00:00.000Z", "/tmp/elsewhere-a");
    await seed(home, "b-uuid", "2026-07-24T11:00:00.000Z", "/tmp/elsewhere-b");

    // Act
    const own = await resolveOwnWorkContext(home, identity(), HUB);

    // Assert
    expect(own?.sessionAmbiguous).toBe(true);
  });
});

describe("the ambiguity is countable and printed", () => {
  test("doctor counts the worktrees where a position will be refused", () => {
    // Arrange: two live sessions sharing one root, one alone in another.
    const cost = summarizeSeqCost([
      stateOf({ hostSessionKey: "a", repoRoot: ROOT, seqEpoch: EPOCH, eventSeq: 12 }),
      stateOf({ hostSessionKey: "b", repoRoot: ROOT, seqEpoch: EPOCH, eventSeq: 4 }),
      stateOf({ hostSessionKey: "c", repoRoot: OTHER_ROOT, seqEpoch: EPOCH, eventSeq: 9 }),
    ]);

    // Assert
    expect(cost.sessions).toBe(3);
    expect(cost.sequenced).toBe(3);
    expect(cost.unsequenced).toBe(0);
    expect(cost.allocated).toBe(25);
    expect(cost.ambiguousRoots).toBe(1);
    expect(formatSeqCost(cost)).toContain("1 worktree");
    expect(seqWarning(cost)).not.toBeNull();
  });

  test("a session with no epoch is counted as unsequenced, and says so", () => {
    // Arrange: a state file from before this protocol field. Its records land
    // and carry no position — a fact a reader must be able to see.
    const cost = summarizeSeqCost([
      stateOf({ hostSessionKey: "a", seqEpoch: null }),
      stateOf({ hostSessionKey: "b", repoRoot: OTHER_ROOT, seqEpoch: EPOCH, eventSeq: 2 }),
    ]);

    // Assert
    expect(cost.unsequenced).toBe(1);
    expect(formatSeqCost(cost)).toContain("1 with no position");
    expect(seqWarning(cost)).not.toBeNull();
  });

  test("a healthy machine warns about nothing", () => {
    // Arrange
    const cost = summarizeSeqCost([
      stateOf({ hostSessionKey: "a", seqEpoch: EPOCH, eventSeq: 7 }),
    ]);

    // Assert
    expect(seqWarning(cost)).toBeNull();
    expect(formatSeqCost(cost)).toContain("7");
  });

  test("a window the cap evicted is counted and printed for what it cost", () => {
    // Arrange: MAX_TOOL_WINDOWS is a CHOSEN number — no hook payload says how
    // many calls are running at once. An eviction costs a call that was STILL
    // RUNNING its bracket and nothing else (its position stays the upper bound
    // it was, and the hub refuses rather than answers), so it is not a WARN
    // and has no remedy a reader could act on. It is printed because a real
    // install reaching the ceiling is the ONLY thing that can say the number
    // is too small. And it says "evicted", not "dropped": a call that ended
    // with no post hook to close its window (a denied or aborted call) is
    // evicted too, and cost nothing — the count is an upper bound on the
    // brackets lost, and the line must not read as an exact one.
    const cost = summarizeSeqCost([
      stateOf({ hostSessionKey: "a", seqEpoch: EPOCH, eventSeq: 9, toolWindowEvictions: 2 }),
      stateOf({
        hostSessionKey: "b",
        repoRoot: OTHER_ROOT,
        seqEpoch: EPOCH,
        eventSeq: 4,
        toolWindowEvictions: 1,
      }),
    ]);

    // Assert
    expect(cost.windowEvictions).toBe(3);
    expect(formatSeqCost(cost)).toContain(
      "3 tool window(s) evicted at the cap (an edit still running when its window went travels as an upper bound; a call that had already ended lost nothing)",
    );
    expect(formatSeqCost(cost)).not.toContain("dropped");
    expect(seqWarning(cost)).toBeNull();
  });

  test("a machine that never hit the window cap prints no eviction count", () => {
    // Arrange: ABSENT IS NOT ZERO everywhere else in this line, and zero
    // evictions is the ordinary machine — printing "0 dropped" would be noise
    // on every healthy install forever.
    const cost = summarizeSeqCost([
      stateOf({ hostSessionKey: "a", seqEpoch: EPOCH, eventSeq: 7 }),
    ]);

    // Assert
    expect(cost.windowEvictions).toBe(0);
    expect(formatSeqCost(cost)).not.toContain("evicted");
  });

  test("an edit that reached the hub with no window is counted and printed", () => {
    // Arrange: THE LOSS THE EVICTION COUNT CANNOT SEE. A PreToolUse whose
    // `openToolWindow` the busy state lock refused writes no entry at all, so
    // nothing is ever evicted for it and the cap's counter stays 0 — while the
    // edit reaches the hub unbracketed and every happens-before question
    // against it is refused. Measured through the real hooks under an ordinary
    // parallel turn on a loaded machine: refusals at 0.4-1.7% of edits with
    // `toolWindowEvictions` exactly 0 throughout. This counts the loss from
    // the side that can SEE it — an edit tool's PostToolUse that took a
    // position and found no window of its own — so the number covers a refused
    // open, a hook installed mid-flight, a state file too old for the list, a
    // host that sends no `tool_use_id` and an evicted entry alike.
    const cost = summarizeSeqCost([
      stateOf({ hostSessionKey: "a", seqEpoch: EPOCH, eventSeq: 9, toolWindowMisses: 2 }),
      stateOf({
        hostSessionKey: "b",
        repoRoot: OTHER_ROOT,
        seqEpoch: EPOCH,
        eventSeq: 4,
        toolWindowMisses: 3,
      }),
    ]);

    // Assert: counted, printed, and NOT a WARN — the losses are load-driven
    // and no reader can act on them, which is this tree's rule for a cost
    // nobody chose.
    expect(cost.windowMisses).toBe(5);
    expect(formatSeqCost(cost)).toContain(
      "5 edit(s) recorded with no window of their own (unbracketed: the hub refuses every `declared before` question against them)",
    );
    expect(seqWarning(cost)).toBeNull();
  });

  test("a machine that lost no bracket prints no unbracketed count", () => {
    // Arrange: silent at zero, exactly like the two counts beside it.
    const cost = summarizeSeqCost([
      stateOf({ hostSessionKey: "a", seqEpoch: EPOCH, eventSeq: 7 }),
    ]);

    // Assert
    expect(cost.windowMisses).toBe(0);
    expect(formatSeqCost(cost)).not.toContain("no window of their own");
  });

  test("no live sessions says so rather than printing zeros", () => {
    expect(formatSeqCost(summarizeSeqCost([]))).toBe("no live sessions");
    expect(seqWarning(summarizeSeqCost([]))).toBeNull();
  });
});

describe("a refused position says WHICH refusal, because the remedies differ", () => {
  /**
   * Both refusals withhold a position, and there the resemblance ends.
   *
   *   allocation_failed             — this machine tried and could not: a busy
   *                                   lock, a deleted state file. It CLEARS ON
   *                                   ITS OWN, and the remedy is to do nothing.
   *   ambiguous_session_assignment  — the picker could not tell which of two
   *                                   live sessions is calling, so no lock was
   *                                   taken at all. Nothing clears until one of
   *                                   the two sessions ends, and the remedy is
   *                                   a person closing one.
   *
   * Collapsing them into one word sends the reader of a permanently ambiguous
   * worktree to wait for a lock that was never contended.
   */
  const ctxFor = (home: string): McpContext =>
    ({ config: { home } }) as McpContext;

  test("an ambiguous session refuses with its own reason, not the busy-lock one", async () => {
    // Arrange: two live sessions, one worktree — the shape the picker's own
    // header calls indistinguishable.
    const home = await newHome("mcp-seq-reason-ambig");
    await seed(home, "one-uuid", "2026-07-24T09:00:00.000Z");
    await seed(home, "two-uuid", "2026-07-24T11:00:00.000Z");
    const own = await resolveOwnWorkContext(home, identity(), HUB);
    if (own === null) {
      throw new Error("the picker resolved nothing to refuse a position for");
    }

    // Act
    const seq = seqAt(await allocateToolSeq(ctxFor(home), own, 1), 0);

    // Assert
    expect(seq).toEqual({ reason: "ambiguous_session_assignment" });
  });

  test("one session in the worktree still gets a real position", async () => {
    // Arrange: the same call on an unambiguous machine, so the assertion above
    // is about the ambiguity and not about the harness.
    const home = await newHome("mcp-seq-reason-alone");
    await seed(home, "alone-uuid", "2026-07-24T09:00:00.000Z");
    const own = await resolveOwnWorkContext(home, identity(), HUB);
    if (own === null) {
      throw new Error("the picker resolved nothing to position");
    }

    // Act
    const seq = seqAt(await allocateToolSeq(ctxFor(home), own, 1), 0);

    // Assert: the seeded state file is at eventSeq 3, so the next is 4.
    expect(seq).toEqual({ epoch: EPOCH, n: 4 });
  });
});
