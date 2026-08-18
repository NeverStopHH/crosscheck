/**
 * HOOK_RESERVE_RATIO, asserted as ARITHMETIC. This is the guard
 * scripts/mutation-check.ts runs for the reserve.
 *
 * WHY THIS FILE EXISTS. The reserve was guarded only through its WALL-CLOCK SIDE
 * EFFECT: remove it and maintenance eats the hook that hosts it, so the briefing
 * goes missing, the `end` is never sent and `elapsedMs` beats a ceiling. That is
 * what test/hook-time-budget.test.ts measures, through real processes, and it
 * still does — nothing here replaces it. But whether those flags flip depends on
 * how long maintenance takes on the machine running the check, so the check was
 * a bet on machine speed, and it is a weak bet in a way no single machine
 * explains: the process-level file stays GREEN under HOOK_RESERVE_RATIO set to
 * 0.999, 0.5 or 1.0000001, and under removal of the Math.max floor. Apply any of
 * those to src/constants.ts and run that file to see it. HISTORICAL, observed
 * once on 2026-07-29 and not re-derivable here: GitHub's hosted runner reported
 * this mutation NOT CAUGHT in a run that caught every other one, while every
 * configuration reachable from this desk caught it. Making the bet better would
 * only move the machine at which it fails.
 *
 * So the clock is taken out of the detecting path instead. The reserve IS a
 * subtraction; `hookBudget` takes its clock as a parameter, every test below
 * passes a frozen one, and none of them spawns a process, opens a file or reads
 * a real clock. What they assert is therefore a property of the code and of
 * nothing else — the same answer on a loaded laptop and on an idle runner. It is
 * also why this is the file the mutation check points at: it costs milliseconds
 * on every pull request, where the process-level file costs seconds.
 *
 * WHAT THIS FILE DOES NOT COVER, deliberately. That `hookBudget`'s DEFAULT clock
 * is the real one. Default it to something frozen and every test here still
 * passes while production computes a spare that never shrinks — which is exactly
 * the `spare bound removed` variant of scripts/measure-ceiling-detection.ts, and
 * that variant takes the process-level suite red on behavioural assertions. The
 * division is deliberate: this file owns the arithmetic, that one owns the
 * consequence, and neither is sufficient alone.
 *
 * ONE CONSUMER, which is what makes a unit test of it sufficient at all: a
 * constant read in two places can be defeated in one and survive in the other.
 * hooks/runner.ts is the only reader outside the constant's own declaration —
 *
 * VERIFY: grep -rl HOOK_RESERVE_RATIO packages/connector-claude/src packages/connector-core/src | sort
 * PRINTS: packages/connector-claude/src/hooks/runner.ts
 * PRINTS: packages/connector-core/src/constants.ts
 *
 * — and `spareMs` is in turn the sole accessor on HookBudget, taken as a whole
 * deadline by the drain in each of the four hooks that host one (SessionStart,
 * SessionEnd, PostToolUse, Stop) and read once more by SessionStart's
 * deferred end:
 *
 * VERIFY: grep -rn 'budget\.spareMs()' packages/connector-claude/src | wc -l | tr -d ' '
 * PRINTS: 5
 */
import { describe, expect, test } from "bun:test";

import { HTTP_TIMEOUT_MS } from "@crosscheck/connector-core/constants.ts";
import { hookBudget } from "../src/hooks/runner.ts";

/** A frozen clock. The reserve is arithmetic; asserting it needs no real one. */
const frozen =
  (nowMs: number) =>
  (): number =>
    nowMs;

const NOW_MS = 1_000_000;

/**
 * A remainder several reserves wide, so "less than the raw remainder" is a
 * statement about the subtraction rather than about a few stray milliseconds.
 */
const REMAINING_MS = 10_000;

/** What maintenance is offered when `remainingMs` of the hook's budget is left. */
const spareWith = (remainingMs: number, timeoutMs: number): number =>
  hookBudget(NOW_MS + remainingMs, timeoutMs, frozen(NOW_MS)).spareMs();

describe("the hook reserve", () => {
  test("withholds it instead of handing maintenance the raw remainder", () => {
    // Arrange: 10 s of hook budget left, the default 400 ms request timeout

    // Act
    const spare = spareWith(REMAINING_MS, HTTP_TIMEOUT_MS);

    // Assert: strictly short of the remainder, by exactly one request timeout —
    // with HOOK_RESERVE_RATIO = 0 this returns the remainder whole, which is the
    // defect that cost SessionStart its briefing and SessionEnd its `end`.
    expect(spare).toBeLessThan(REMAINING_MS);
    expect(spare).toBe(REMAINING_MS - HTTP_TIMEOUT_MS);
  });

  test.each([250, HTTP_TIMEOUT_MS, 1500])(
    "reserves one whole request timeout when that timeout is %i ms",
    (timeoutMs: number) => {
      // Arrange / Act: the same remainder, a hub configured slower or faster
      const spare = spareWith(REMAINING_MS, timeoutMs);

      // Assert: the reserve tracks CROSSCHECK_TIMEOUT_MS, because a single hub
      // call is the longest thing it has to still fit afterwards
      expect(REMAINING_MS - spare).toBe(timeoutMs);
    },
  );

  test("leaves nothing spare once only the reserve is left", () => {
    // Arrange / Act: a hook with exactly one request timeout to its deadline,
    // and one a millisecond short of that

    // Assert: zero, which is the state SessionStart's deferred end reads as
    // "keep the marker, make no hub call" (hooks/session-start.ts) and the drain
    // reads as "send nothing" — under the defect both would be handed 400 ms
    // that the hook cannot pay for.
    expect(spareWith(HTTP_TIMEOUT_MS, HTTP_TIMEOUT_MS)).toBe(0);
    expect(spareWith(HTTP_TIMEOUT_MS - 1, HTTP_TIMEOUT_MS)).toBe(0);
  });

  test("floors at zero rather than offering a deadline already gone", () => {
    // Arrange / Act: a hook whose budget expired 10 s ago

    // Assert: never negative — a negative would be passed on as a request
    // timeout and is the one value no caller of spareMs checks for.
    expect(spareWith(-REMAINING_MS, HTTP_TIMEOUT_MS)).toBe(0);
  });
});
