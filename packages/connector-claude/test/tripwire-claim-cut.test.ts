/**
 * THE PERSON'S LINE IS PART OF THE CLAIM, AND A CUT UNDOES THE CLAIM
 * (batch-2 integration review, H2).
 *
 * Before, PreToolUse claimed the ask, then — last, and only while the spare
 * budget lasted — recorded the teammate group told, queued the subagent's
 * relay and started the file's rest. Under load the spare was gone by the
 * time the hub answered: the subagent's agent was warned, and nothing else
 * happened — no relay for the main thread, no rest, nothing counted (4/4 at
 * 350 ms in the review's re-run; 1 person line in 10 storm runs). And when
 * the race cut the hook right after the claim, the ask was spent with
 * nothing shown, for the rest of the session.
 *
 * Now ONE locked write claims the ask, records the groups told, queues the
 * relay and starts the rest — whatever the spare — and registers its undo
 * with the race. A cut hook gives the claim back: the ask is re-asked on the
 * file's next edit, a main-thread group goes back to untold, the file owes a
 * recheck at once (paid by the next hook: told, or booked `rest_unchecked`),
 * and the cut itself is booked `tripwire_cut`. A subagent's relay stays
 * queued: it reaches the person whatever became of the subagent's output.
 *
 * The timings are deterministic: a budget held at zero, a race lost by a
 * handler that waits for the cut, and a hub that holds its tripwire answer
 * the review's 0, 300 and 350 ms.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { runHook } from "../src/index.ts";
import { handlePreToolUse } from "../src/hooks/pre-tool-use.ts";
import { handleUserPromptSubmit } from "../src/hooks/user-prompt-submit.ts";
import { prepareHook, runHookWith } from "../src/hooks/runner.ts";
import type { HookBudget, HookContext } from "../src/hooks/runner.ts";
import type { Env } from "../src/index.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import { readRestOmissions } from "@crosscheck/connector-core/state/rest-omissions.ts";
import { overdueRests, readSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import type { SessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { TEAMMATE_DEVELOPER_ID } from "../../connector-core/test/fixtures/hint-hub.ts";
import {
  BEHAVIOUR_TIMING,
  NICK_NOTICE,
  OVERLAP_FILE,
  REPO_ID,
  SESSION_ID,
  SUBAGENT,
  cleanupCollisionFixtures,
  collisionFixture,
  editPayload,
  parsed,
  presentNow,
  promptPayload,
} from "./fixtures/collision-fixture.ts";
import type { CollisionFixture } from "./fixtures/collision-fixture.ts";

afterEach(cleanupCollisionFixtures);

const SPENT: HookBudget = { spareMs: () => 0 };
const AMPLE: HookBudget = { spareMs: () => 60_000 };
/** A race already lost: the hook's output is never read. */
const LOST: HookBudget = { spareMs: () => 60_000, isCut: () => true, onCut: () => undefined };

/** The review's tripwire latencies at the production 400 ms request timeout. */
const REVIEW_LATENCIES_MS = [0, 300, 350] as const;
/** A request timeout whose budget leaves the handler's own work ample room before the cut. */
const CUT_REQUEST_TIMEOUT_MS = "1000";
const POLL_MS = 10;
const MAX_WAIT_MS = 10_000;
const CUT_TEST_TIMEOUT_MS = 30_000;
const TOOL_USE_ID = "toolu_cut_1";

/** Nick's work context, as the tripwire's row names it (hint-hub activeTeammateSession). */
const NICK_ASK_KEY = JSON.stringify([OVERLAP_FILE, TEAMMATE_DEVELOPER_ID, "wc_nick"]);

const contextFor = async (stdin: string, env: Env): Promise<HookContext> => {
  const ctx = await prepareHook(stdin, env);
  if (ctx === null) {
    throw new Error("the fixture did not resolve a reportable repo");
  }
  return ctx;
};

const stateOf = async (home: string): Promise<SessionState> => {
  const state = await readSessionState(home, SESSION_ID);
  if (state === null) {
    throw new Error("no session state");
  }
  return state;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Holds until the race has cut this hook (or gives up), so the race is lost deterministically. */
const untilCut = async (budget: HookBudget): Promise<void> => {
  const started = Date.now();
  while (budget.isCut?.() !== true && Date.now() - started < MAX_WAIT_MS) {
    await sleep(POLL_MS);
  }
};

/** The real PreToolUse, which then waits out its race: everything it claimed, it claimed before the cut. */
const claimsThenLoses = async (ctx: HookContext, budget: HookBudget): Promise<string> => {
  const output = await handlePreToolUse(ctx, budget);
  await untilCut(budget);
  return output;
};

/** One PreToolUse through the real runner, cut by its budget right after its claim. */
const cutEdit = async (fix: CollisionFixture, extra: Record<string, string> = {}): Promise<string> =>
  runHookWith(
    "pre-tool-use",
    claimsThenLoses,
    editPayload(fix.repo, OVERLAP_FILE, { tool_use_id: TOOL_USE_ID, ...extra }),
    { ...fix.env, CROSSCHECK_TIMEOUT_MS: CUT_REQUEST_TIMEOUT_MS },
  );

const tripwireCuts = async (fix: CollisionFixture): Promise<number> =>
  (await readRestOmissions(fix.home, repoKey(fix.hub.url, REPO_ID), new Date())).byReason.tripwire_cut;

describe("the person's line is claimed with the ask, whatever the spare (H2 a)", () => {
  test("with the spare spent, the ask and the person's line leave together, and the file rests", async () => {
    // Arrange
    const { repo, home, env } = await collisionFixture("cc-spent");
    const ctx = await contextFor(editPayload(repo, OVERLAP_FILE), env);

    // Act
    const output = parsed(await handlePreToolUse(ctx, SPENT));

    // Assert
    expect(output.hookSpecificOutput?.permissionDecision).toBe("ask");
    expect(output.systemMessage).toBe(NICK_NOTICE);
    const state = await stateOf(home);
    expect(state.collisionNotices).toHaveLength(1);
    expect(state.tripwireAskedGroups).toEqual([NICK_ASK_KEY]);
    expect((state.tripwireCheckedFiles ?? []).map((check) => check.file)).toEqual([OVERLAP_FILE]);
  });

  test("a subagent's hit with the spare spent is queued for the main thread, whose next prompt tells the person", async () => {
    // Arrange
    const fix = await collisionFixture("cc-subagent-spent");
    await handlePreToolUse(await contextFor(editPayload(fix.repo, OVERLAP_FILE, SUBAGENT), fix.env), SPENT);
    const queued = await stateOf(fix.home);
    await presentNow(fix, [TEAMMATE_DEVELOPER_ID]);

    // Act
    const prompt = parsed(await handleUserPromptSubmit(await contextFor(promptPayload(fix.repo), fix.env), AMPLE));

    // Assert
    expect(queued.collisionRelayQueue).toHaveLength(1);
    expect(prompt.systemMessage).toContain(NICK_NOTICE);
  });

  test("a claim the race has already lost is never made", async () => {
    // Arrange
    const { repo, home, env } = await collisionFixture("cc-lost");
    const ctx = await contextFor(editPayload(repo, OVERLAP_FILE, SUBAGENT), env);

    // Act
    const output = await handlePreToolUse(ctx, LOST);

    // Assert
    expect(output).toBe("");
    const state = await stateOf(home);
    expect(state.tripwireAskedGroups ?? []).toEqual([]);
    expect(state.collisionNotices ?? []).toEqual([]);
    expect(state.collisionRelayQueue ?? []).toEqual([]);
  });
});

describe("a cut hook gives its claim back, and the cut is booked (H2 b)", () => {
  test(
    "a main-thread hit the race cut: the ask is released, the group untold, the file owes a recheck, the cut is booked",
    async () => {
      // Arrange
      const fix = await collisionFixture("cc-cut-main", BEHAVIOUR_TIMING);

      // Act
      const output = await cutEdit(fix);

      // Assert
      expect(output).toBe("");
      const state = await stateOf(fix.home);
      expect(state.tripwireAskedGroups ?? []).toEqual([]);
      expect(state.collisionNotices ?? []).toEqual([]);
      expect(overdueRests(state, new Date()).map((rest) => rest.file)).toEqual([OVERLAP_FILE]);
      expect(await tripwireCuts(fix)).toBe(1);
    },
    CUT_TEST_TIMEOUT_MS,
  );

  test(
    "the debt is paid by the next prompt: the person is told after all",
    async () => {
      // Arrange
      const fix = await collisionFixture("cc-cut-paid", BEHAVIOUR_TIMING);
      await cutEdit(fix);

      // Act
      const prompt = parsed(await runHook("user-prompt-submit", promptPayload(fix.repo), fix.env));

      // Assert
      expect(prompt.systemMessage).toContain(NICK_NOTICE);
    },
    CUT_TEST_TIMEOUT_MS,
  );

  test(
    "the file's next edit asks again",
    async () => {
      // Arrange
      const fix = await collisionFixture("cc-cut-reask", BEHAVIOUR_TIMING);
      await cutEdit(fix);

      // Act
      const next = parsed(await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE), fix.env));

      // Assert
      expect(next.hookSpecificOutput?.permissionDecision).toBe("ask");
      expect(next.systemMessage).toBe(NICK_NOTICE);
    },
    CUT_TEST_TIMEOUT_MS,
  );

  test(
    "a subagent's hit the race cut keeps its relay queued, and the main thread's next prompt tells the person",
    async () => {
      // Arrange
      const fix = await collisionFixture("cc-cut-subagent", BEHAVIOUR_TIMING);
      await cutEdit(fix, SUBAGENT);
      const afterCut = await stateOf(fix.home);
      await presentNow(fix, [TEAMMATE_DEVELOPER_ID]);

      // Act
      const prompt = parsed(await runHook("user-prompt-submit", promptPayload(fix.repo), fix.env));

      // Assert
      expect(afterCut.tripwireAskedGroups ?? []).toEqual([]);
      expect(afterCut.collisionRelayQueue).toHaveLength(1);
      expect(await tripwireCuts(fix)).toBe(1);
      expect(prompt.systemMessage).toContain(NICK_NOTICE);
    },
    CUT_TEST_TIMEOUT_MS,
  );

  test(
    "a cut hook whose tripwire named nobody books no tripwire cut",
    async () => {
      // Arrange
      const fix = await collisionFixture("cc-cut-nobody", BEHAVIOUR_TIMING);
      fix.hub.setTripwireSessions([]);

      // Act
      await cutEdit(fix);

      // Assert
      expect(await tripwireCuts(fix)).toBe(0);
    },
    CUT_TEST_TIMEOUT_MS,
  );
});

describe("the review's timings: a subagent's hit on a hub that answers in time, but late (V3d)", () => {
  for (const latencyMs of REVIEW_LATENCIES_MS) {
    test(
      `at ${String(latencyMs)} ms the main thread tells the person once`,
      async () => {
        // Arrange: the production request timeout (the env unset) and a hub that holds the tripwire answer
        const fix = await collisionFixture(`cc-v3d-${String(latencyMs)}`, { tripwireLatencyMs: latencyMs });
        await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE, SUBAGENT), fix.env);
        await presentNow(fix, [TEAMMATE_DEVELOPER_ID]);

        // Act
        const prompt = parsed(await runHook("user-prompt-submit", promptPayload(fix.repo), fix.env));

        // Assert
        expect(prompt.systemMessage).toContain(NICK_NOTICE);
      },
      CUT_TEST_TIMEOUT_MS,
    );
  }
});
