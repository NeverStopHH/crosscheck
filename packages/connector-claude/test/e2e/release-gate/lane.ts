/**
 * THE RELEASE GATE'S LANE SWITCH (the fixtures/budget-lane.ts convention).
 *
 * The realistic gate runs where it can be judged: its own CI job, alone on
 * the runner, with `CX_GATE_LANE` naming the lane —
 *  - `production` (ci.yml, every pull request): production budgets, every
 *    hook a process, parallel subagents, a compaction and a resume;
 *  - `loaded` (the nightly / release-candidate workflow): the same under CPU
 *    burners (release-gate/burners.ts).
 * Inside the ordinary suite — six other files' processes beside it, both
 * operating systems — a production budget would judge the runner, not the
 * product. There it skips LOUDLY and names the command that runs it: a skip
 * nobody sees is a gate nobody runs. The generous variant
 * (release-gate-generous.e2e.test.ts) is the gate's form for that suite.
 */
export const GATE_LANE_ENV = "CX_GATE_LANE";

export type GateLane = "production" | "loaded";

export const inGateLane = (lane: GateLane): boolean => process.env[GATE_LANE_ENV] === lane;

/** One line outside the lane, naming how to run it. */
export const announceGateLaneSkip = (file: string, lane: GateLane): void => {
  if (!inGateLane(lane)) {
    console.log(`${file}: SKIPPED — the release gate's ${lane} lane: ${GATE_LANE_ENV}=${lane} bun test ${file}`);
  }
};
