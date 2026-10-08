/**
 * THE HOOK BUDGETS LANE SWITCH, for a test whose only judge is a wall-clock
 * number on the machine running it.
 *
 * Such a test is a MEASUREMENT: on a runner shared with six other suites it
 * goes red with no behaviour wrong (the load run behind this file saw the
 * "one spool append" p95 at 21 ms against its 5 ms allowance, and the ACP
 * flood past bun's 5 s timeout, with nothing else failing beside them). So it
 * runs where measurements belong: ci.yml's `budgets` job, isolated, with
 * CX_BUDGET_LANE=1 — and under scripts/mutation-check.ts, whose guard runs
 * set it, so an anchor that a gated test guards is still proven (run
 * prove-labels tools with it exported for the same reason). Everywhere else it skips
 * LOUDLY and names the command that runs it, the cpu-starved-e2e.test.ts
 * convention: a skip nobody sees is a test nobody runs.
 *
 * Thresholds are not touched by being gated: the test asserts the same number
 * in the lane that it asserted in the ordinary suite.
 */

export const BUDGET_LANE_ENV = "CX_BUDGET_LANE";

/** True only inside the budgets lane (and the mutation job). */
export const IN_BUDGET_LANE = process.env[BUDGET_LANE_ENV] === "1";

/** One line per gated test outside the lane, naming how to run it. */
export const announceBudgetLaneSkip = (file: string, testName: string): void => {
  if (!IN_BUDGET_LANE) {
    console.log(
      `${file}: SKIPPED "${testName}" — a wall-clock budget, run in the Hook budgets lane: ` +
        `${BUDGET_LANE_ENV}=1 bun test ${file}`,
    );
  }
};
