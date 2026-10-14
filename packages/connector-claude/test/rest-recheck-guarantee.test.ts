/**
 * THE RECHECK EVERY REST OWES IS PAID OR COUNTED (round 3, F-M2, accepted on
 * the owner's condition). A 30 s rest keeps an edit from asking the hub, so a
 * teammate who starts on the file inside it is seen by no edit; the turn's
 * end asks again (test/turn-end-hook.test.ts). These pin what happens when it
 * does not: a turn that crashed before its end, a turn's end its budget cut,
 * more rests than one turn's end may ask about. The debt stays in session
 * state until a tripwire call pays it — the next hook that finds its rest
 * over — and a debt no hook can pay is booked as a `rest_unchecked` capture
 * loss, once per file, which `doctor` and `status` print. Never dropped.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { utimes } from "node:fs/promises";

import { runHook } from "../src/index.ts";
import { bookOwedRestsAtEnd } from "../src/hooks/rest-recheck.ts";
import { prepareHook } from "../src/hooks/runner.ts";
import { handleTurnEnd } from "../src/hooks/turn-end.ts";
import { COLLISION_RELAY_SENTENCE, collisionKey } from "@crosscheck/connector-core/hints/collision-notice.ts";
import { repoKey, sessionStatePath } from "@crosscheck/connector-core/config/paths.ts";
import { MAX_SPOOL_AGE_DAYS, MS_PER_DAY, TURN_END_RECHECK_MAX_FILES } from "@crosscheck/connector-core/constants.ts";
import { readCaptureLosses } from "@crosscheck/connector-core/state/loss-ledger.ts";
import { readRestOmissions } from "@crosscheck/connector-core/state/rest-omissions.ts";
import { reapStaleSessionStates } from "@crosscheck/connector-core/state/session-reap.ts";
import { readSessionState, sessionStateLockPath, updateSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { withLock } from "@crosscheck/connector-core/spool/lock.ts";
import { activeTeammateSession } from "../../connector-core/test/fixtures/hint-hub.ts";
import {
  BEHAVIOUR_TIMING,
  NICK_NOTICE,
  OVERLAP_FILE,
  REPO_ID,
  SECOND_FILE,
  SESSION_ID,
  SUBAGENT,
  cleanupCollisionFixtures,
  collisionFixture,
  editPayload,
  kenSession,
  parsed,
  pastRecheckWindow,
  promptPayload,
} from "./fixtures/collision-fixture.ts";
import type { CollisionFixture } from "./fixtures/collision-fixture.ts";

afterEach(cleanupCollisionFixtures);

const KEN_NOTICE =
  "crosscheck: Ken is working on refresh.ts on branch feat/ken-rotation (last active just now) — " +
  "talk before you both change it";

/** What a hub that cannot answer the tripwire returns. */
const SERVICE_UNAVAILABLE = 503;

/** Two past the cap one turn's end may ask about. */
const OVER_THE_CAP = TURN_END_RECHECK_MAX_FILES + 2;

const turnEnded = (repo: string): string =>
  JSON.stringify({ session_id: SESSION_ID, cwd: repo, hook_event_name: "Stop", stop_hook_active: false });

const sessionEnded = (repo: string): string =>
  JSON.stringify({ session_id: SESSION_ID, cwd: repo, hook_event_name: "SessionEnd", reason: "exit" });

const agentReturned = (repo: string): string =>
  JSON.stringify({
    session_id: SESSION_ID,
    cwd: repo,
    hook_event_name: "PostToolUse",
    tool_name: "Agent",
    tool_input: {},
    tool_response: { status: "completed" },
  });

/** The rechecks this session still owes, by file. */
const owedFiles = async (fix: CollisionFixture): Promise<readonly string[]> =>
  ((await readSessionState(fix.home, SESSION_ID))?.tripwireCheckedFiles ?? []).map((check) => check.file);

/** The `rest_unchecked` losses booked under this repo, in all and by hook. */
const restLosses = async (fix: CollisionFixture): Promise<{ readonly total: number; readonly byDetail: Readonly<Record<string, number>> }> => {
  const losses = await readCaptureLosses(fix.home, repoKey(fix.hub.url, REPO_ID));
  const byDetail = Object.fromEntries(
    Object.entries(losses.byDetail)
      .filter(([key]) => key.startsWith("rest_unchecked:"))
      .map(([key, count]) => [key.slice("rest_unchecked:".length), count]),
  );
  return { total: losses.byKind["rest_unchecked"] ?? 0, byDetail };
};

/** The local omission ledger's `rest_unchecked` lines for this repo: one per booking (core state/rest-omissions.ts). */
const restOmissions = async (fix: CollisionFixture): Promise<number> =>
  (await readRestOmissions(fix.home, repoKey(fix.hub.url, REPO_ID), new Date())).byReason.rest_unchecked;

/** A session whose edits settled `files` with Nick on them: each asked about, told, resting, and owed a recheck. */
const settled = async (label: string, files: readonly string[] = [OVERLAP_FILE]): Promise<CollisionFixture> => {
  const fix = await collisionFixture(label, BEHAVIOUR_TIMING);
  for (const file of files) {
    await runHook("pre-tool-use", editPayload(fix.repo, file), fix.env);
    await runHook("pre-tool-use", editPayload(fix.repo, file), fix.env);
  }
  expect([...(await owedFiles(fix))].sort()).toEqual([...files].sort());
  return fix;
};

/** `count` owed rests on files f0…, settled a second apart, f0 the newest. */
const owing = async (fix: CollisionFixture, count: number): Promise<void> => {
  const now = Date.now();
  await updateSessionState(fix.home, SESSION_ID, (fresh) => ({
    ...fresh,
    tripwireCheckedFiles: Array.from({ length: count }, (_, index) => ({
      file: `src/f${String(index)}.ts`,
      at: new Date(now - (index + 1) * 1_000).toISOString(),
    })).reverse(),
  }));
};

describe("a crash between the edit and the turn's end (round 3, F-M2)", () => {
  test("the next prompt, past the rest, rechecks the file and tells the person of the teammate who joined", async () => {
    // Arrange: Nick settled, Ken joins inside the rest — and the turn never ends: no turn-end runs
    const fix = await settled("rg-crash");
    fix.hub.setTripwireSessions([activeTeammateSession(), kenSession()]);
    await pastRecheckWindow(fix.home);
    const before = fix.hub.calls.tripwire;

    // Act
    const prompt = parsed(await runHook("user-prompt-submit", promptPayload(fix.repo), fix.env));

    // Assert: told to both, paid, and nothing booked
    expect(prompt.systemMessage).toBe(KEN_NOTICE);
    expect(prompt.hookSpecificOutput?.additionalContext).toContain(`${KEN_NOTICE}\n${COLLISION_RELAY_SENTENCE}`);
    expect(fix.hub.calls.tripwire).toBe(before + 1);
    expect(await owedFiles(fix)).toEqual([]);
    expect((await restLosses(fix)).total).toBe(0);
    expect(await restOmissions(fix)).toBe(0);
  });

  test("a prompt that cannot reach the hub books each unpaid rest as rest_unchecked, once per file", async () => {
    // Arrange: two files owed, the turn crashed, and now the hub will not answer
    const fix = await settled("rg-crash-down", [OVERLAP_FILE, SECOND_FILE]);
    await pastRecheckWindow(fix.home);
    fix.hub.setTripwireFailure(SERVICE_UNAVAILABLE);

    // Act: two prompts, so a second hook cannot book the same files again
    await runHook("user-prompt-submit", promptPayload(fix.repo), fix.env);
    await runHook("user-prompt-submit", promptPayload(fix.repo), fix.env);

    // Assert: two files in the capture-loss ledger, one booking in the local
    // omission ledger (the person was not told, once)
    expect(await restLosses(fix)).toEqual({ total: 2, byDetail: { "user-prompt-submit": 2 } });
    expect(await restOmissions(fix)).toBe(1);
    expect(await owedFiles(fix)).toEqual([]);
  });
});

describe("a turn's end cut by its budget (round 3, F-M2)", () => {
  test("pays nothing and keeps every debt; the next hook past the rest pays it", async () => {
    // Arrange: Ken joins inside the rest; the turn's end gets no spare at all
    const fix = await settled("rg-cut");
    fix.hub.setTripwireSessions([activeTeammateSession(), kenSession()]);
    const ctx = await prepareHook(turnEnded(fix.repo), fix.env);
    const before = fix.hub.calls.tripwire;

    // Act
    const ended = ctx === null ? "no context" : await handleTurnEnd(ctx, { spareMs: () => 0 });
    const owedAfterCut = await owedFiles(fix);
    await pastRecheckWindow(fix.home);
    const prompt = parsed(await runHook("user-prompt-submit", promptPayload(fix.repo), fix.env));

    // Assert
    expect(ended).toBe("");
    expect(owedAfterCut).toEqual([OVERLAP_FILE]);
    expect(prompt.systemMessage).toBe(KEN_NOTICE);
    expect(fix.hub.calls.tripwire).toBe(before + 1);
    expect((await restLosses(fix)).total).toBe(0);
  });

  test("a turn's end the hub does not answer keeps the debt, and the next hook books it when it cannot reach the hub either", async () => {
    // Arrange
    const fix = await settled("rg-end-down");
    fix.hub.setTripwireFailure(SERVICE_UNAVAILABLE);

    // Act
    const ended = await runHook("turn-end", turnEnded(fix.repo), fix.env);
    const owedAfterEnd = await owedFiles(fix);
    const bookedAtEnd = (await restLosses(fix)).total;
    await pastRecheckWindow(fix.home);
    await runHook("user-prompt-submit", promptPayload(fix.repo), fix.env);

    // Assert
    expect(ended).toBe("");
    expect(owedAfterEnd).toEqual([OVERLAP_FILE]);
    expect(bookedAtEnd).toBe(0);
    expect(await restLosses(fix)).toEqual({ total: 1, byDetail: { "user-prompt-submit": 1 } });
  });
});

describe("more owed rests than one turn's end may ask about (round 3, F-M2)", () => {
  test("the turn's end pays the newest three and keeps the rest owed; the next turn's end pays them", async () => {
    // Arrange: five rests still running
    const fix = await collisionFixture("rg-cap", BEHAVIOUR_TIMING);
    await owing(fix, OVER_THE_CAP);
    fix.hub.setTripwireSessions([]);

    // Act
    await runHook("turn-end", turnEnded(fix.repo), fix.env);
    const keptAfterFirst = await owedFiles(fix);
    const callsAfterFirst = fix.hub.calls.tripwire;
    await runHook("turn-end", turnEnded(fix.repo), fix.env);

    // Assert: the oldest two were kept, never dropped, and paid next
    expect(callsAfterFirst).toBe(TURN_END_RECHECK_MAX_FILES);
    expect([...keptAfterFirst].sort()).toEqual(["src/f3.ts", "src/f4.ts"]);
    expect(fix.hub.calls.tripwire).toBe(OVER_THE_CAP);
    expect(await owedFiles(fix)).toEqual([]);
    expect((await restLosses(fix)).total).toBe(0);
  });

  test("kept past the cap and then past their rest, they are paid by the next prompt", async () => {
    // Arrange
    const fix = await collisionFixture("rg-cap-overdue", BEHAVIOUR_TIMING);
    await owing(fix, OVER_THE_CAP);
    fix.hub.setTripwireSessions([]);
    await runHook("turn-end", turnEnded(fix.repo), fix.env);
    await pastRecheckWindow(fix.home);

    // Act
    await runHook("user-prompt-submit", promptPayload(fix.repo), fix.env);

    // Assert
    expect(fix.hub.calls.tripwire).toBe(OVER_THE_CAP);
    expect(await owedFiles(fix)).toEqual([]);
    expect((await restLosses(fix)).total).toBe(0);
  });
});

describe("every sync hook pays an overdue rest at its own next opportunity (round 3, F-M2)", () => {
  test("an edit of another file rechecks the overdue rest beside its own answer, and tells the person", async () => {
    // Arrange: refresh.ts settled, Ken joins it, the rest passes; rotate.ts has nobody on it
    const fix = await settled("rg-edit");
    fix.hub.setTripwireSessionsFor(OVERLAP_FILE, [activeTeammateSession(), kenSession()]);
    fix.hub.setTripwireSessionsFor(SECOND_FILE, []);
    await pastRecheckWindow(fix.home);
    const before = fix.hub.calls.tripwire;

    // Act
    const edit = parsed(await runHook("pre-tool-use", editPayload(fix.repo, SECOND_FILE), fix.env));

    // Assert: one call for the edited file, one for the debt
    expect(edit.systemMessage).toBe(KEN_NOTICE);
    expect(fix.hub.calls.tripwire).toBe(before + 2);
    expect(await owedFiles(fix)).toEqual([]);
  });

  test("a subagent's return rechecks an overdue rest though nothing is queued for it", async () => {
    // Arrange
    const fix = await settled("rg-return");
    fix.hub.setTripwireSessions([activeTeammateSession(), kenSession()]);
    await pastRecheckWindow(fix.home);

    // Act
    const returned = parsed(await runHook("subagent-return", agentReturned(fix.repo), fix.env));

    // Assert
    expect(returned.systemMessage).toBe(KEN_NOTICE);
    expect(returned.hookSpecificOutput?.additionalContext).toContain(KEN_NOTICE);
    expect(await owedFiles(fix)).toEqual([]);
  });

  test("a prompt pays at most three overdue rests; the others stay owed for the next hook, unbooked", async () => {
    // Arrange: five rests over
    const fix = await collisionFixture("rg-sweep-cap", BEHAVIOUR_TIMING);
    await owing(fix, OVER_THE_CAP);
    await pastRecheckWindow(fix.home);
    fix.hub.setTripwireSessions([]);

    // Act
    await runHook("user-prompt-submit", promptPayload(fix.repo), fix.env);
    const keptAfterFirst = await owedFiles(fix);
    const callsAfterFirst = fix.hub.calls.tripwire;
    await runHook("user-prompt-submit", promptPayload(fix.repo), fix.env);

    // Assert
    expect(callsAfterFirst).toBe(TURN_END_RECHECK_MAX_FILES);
    expect(keptAfterFirst).toHaveLength(OVER_THE_CAP - TURN_END_RECHECK_MAX_FILES);
    expect(fix.hub.calls.tripwire).toBe(OVER_THE_CAP);
    expect(await owedFiles(fix)).toEqual([]);
    expect((await restLosses(fix)).total).toBe(0);
  });

  test("a subagent's edit that pays an overdue rest queues what it found for the main thread", async () => {
    // Arrange: the main thread settled refresh.ts; Ken joins it; a subagent edits rotate.ts later
    const fix = await settled("rg-subagent-sweep");
    fix.hub.setTripwireSessionsFor(OVERLAP_FILE, [activeTeammateSession(), kenSession()]);
    fix.hub.setTripwireSessionsFor(SECOND_FILE, []);
    await pastRecheckWindow(fix.home);

    // Act
    await runHook("pre-tool-use", editPayload(fix.repo, SECOND_FILE, SUBAGENT), fix.env);

    // Assert
    const state = await readSessionState(fix.home, SESSION_ID);
    expect(state?.collisionRelayQueue).toEqual([collisionKey("dev_ken", "wc_ken")]);
  });

  test("debts the record's cap had to evict are booked by the next pass that settles one", async () => {
    // Arrange: one rest over, and two the cap evicted
    const fix = await settled("rg-evicted");
    await updateSessionState(fix.home, SESSION_ID, (fresh) => ({ ...fresh, tripwireRestsDropped: 2 }));
    await pastRecheckWindow(fix.home);

    // Act
    await runHook("user-prompt-submit", promptPayload(fix.repo), fix.env);

    // Assert
    expect(await restLosses(fix)).toEqual({ total: 2, byDetail: { "user-prompt-submit": 2 } });
    expect((await readSessionState(fix.home, SESSION_ID))?.tripwireRestsDropped).toBe(0);
  });

  test("a rest still running is the turn's end's: the next prompt asks no tripwire for it", async () => {
    // Arrange
    const fix = await settled("rg-running");
    const before = fix.hub.calls.tripwire;

    // Act
    await runHook("user-prompt-submit", promptPayload(fix.repo), fix.env);

    // Assert
    expect(fix.hub.calls.tripwire).toBe(before);
    expect(await owedFiles(fix)).toEqual([OVERLAP_FILE]);
  });
});

describe("an unanswered tripwire leaves a recheck owed (review batch 2, M1)", () => {
  test("the edit the hub did not answer owes a recheck, and the next prompt pays it and tells the person", async () => {
    // Arrange: Nick is on the file, and the hub does not answer the edit's tripwire
    const fix = await collisionFixture("rg-unanswered", BEHAVIOUR_TIMING);
    fix.hub.setTripwireFailure(SERVICE_UNAVAILABLE);

    // Act
    const edit = await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE), fix.env);
    const owedAfterEdit = await owedFiles(fix);
    fix.hub.setTripwireFailure(null);
    const prompt = parsed(await runHook("user-prompt-submit", promptPayload(fix.repo), fix.env));

    // Assert: silent at the edit, owed after it, told at the next hook
    expect(edit).toBe("");
    expect(owedAfterEdit).toEqual([OVERLAP_FILE]);
    expect(prompt.systemMessage).toBe(NICK_NOTICE);
    expect(await owedFiles(fix)).toEqual([]);
    expect((await restLosses(fix)).total).toBe(0);
  });

  test("a hub that still does not answer at the next prompt books the file", async () => {
    // Arrange
    const fix = await collisionFixture("rg-unanswered-down", BEHAVIOUR_TIMING);
    fix.hub.setTripwireFailure(SERVICE_UNAVAILABLE);

    // Act
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE), fix.env);
    await runHook("user-prompt-submit", promptPayload(fix.repo), fix.env);

    // Assert
    expect(await restLosses(fix)).toEqual({ total: 1, byDetail: { "user-prompt-submit": 1 } });
    expect(await owedFiles(fix)).toEqual([]);
  });
});

describe("a session that ends owing rechecks (round 3, F-M2)", () => {
  test("SessionEnd books every debt as rest_unchecked before the state goes", async () => {
    // Arrange: two files owed, and the session ends without its turn's end
    const fix = await settled("rg-end", [OVERLAP_FILE, SECOND_FILE]);

    // Act
    await runHook("session-end", sessionEnded(fix.repo), fix.env);

    // Assert
    expect(await restLosses(fix)).toEqual({ total: 2, byDetail: { "session-end": 2 } });
    expect(await restOmissions(fix)).toBe(1);
  });

  test("SessionEnd under a state lock that stays busy still books every debt (review batch 2, M8)", async () => {
    // Arrange: two files owed, and a sibling hook holds the state lock past
    // SessionEnd's patience — its delete then falls back without the lock.
    const fix = await settled("rg-end-busy", [OVERLAP_FILE, SECOND_FILE]);
    const release: { value: () => void } = { value: () => undefined };
    const held = withLock(sessionStateLockPath(fix.home, SESSION_ID), undefined, () =>
      new Promise<void>((done) => {
        release.value = done;
      }),
    );

    // Act
    try {
      await runHook("session-end", sessionEnded(fix.repo), fix.env);
    } finally {
      release.value();
      await held;
    }

    // Assert: the state is gone, and its debts went to the ledgers, not with it.
    expect(await readSessionState(fix.home, SESSION_ID)).toBeNull();
    expect(await restLosses(fix)).toEqual({ total: 2, byDetail: { "session-end": 2 } });
    expect(await restOmissions(fix)).toBe(1);
  });

  test("the debts SessionEnd booked under a busy lock are not booked again by the reaper that finds the state (final review of batch 2, N10)", async () => {
    // Arrange: two files owed; a sibling holds the state lock past SessionEnd's
    // patience, so the booking comes from the unlocked read — and the hook is
    // cut before its state delete, so the state survives with its rests.
    const fix = await settled("rg-end-busy-cut", [OVERLAP_FILE, SECOND_FILE]);
    const release: { value: () => void } = { value: () => undefined };
    const held = withLock(sessionStateLockPath(fix.home, SESSION_ID), undefined, () =>
      new Promise<void>((done) => {
        release.value = done;
      }),
    );
    const ctx = await prepareHook(sessionEnded(fix.repo), fix.env);
    if (ctx === null) {
      throw new Error("the fixture did not resolve a reportable repo");
    }
    try {
      await bookOwedRestsAtEnd(ctx, "session-end");
    } finally {
      release.value();
      await held;
    }
    expect(await restLosses(fix)).toEqual({ total: 2, byDetail: { "session-end": 2 } });
    expect((await readSessionState(fix.home, SESSION_ID))?.tripwireCheckedFiles).toHaveLength(2);

    // Act: a week later the reaper finds the corpse
    const deadAt = new Date(Date.now() - (MAX_SPOOL_AGE_DAYS + 1) * MS_PER_DAY);
    await updateSessionState(fix.home, SESSION_ID, (fresh) => ({
      ...fresh,
      startedAt: deadAt.toISOString(),
      lastHeartbeatAt: deadAt.toISOString(),
    }));
    await utimes(sessionStatePath(fix.home, SESSION_ID), deadAt, deadAt);
    const reaped = await reapStaleSessionStates(fix.home, new Date());

    // Assert: the state goes, and the debts are counted once
    expect(reaped).toBe(1);
    expect(await readSessionState(fix.home, SESSION_ID)).toBeNull();
    expect(await restLosses(fix)).toEqual({ total: 2, byDetail: { "session-end": 2 } });
    expect(await restOmissions(fix)).toBe(1);
  });
});
