/**
 * HOW A GATE RUN TREATS TIME AND CONCURRENCY. Every case of the release gate
 * is built under one profile; the scenarios read it, never a branch name.
 *
 * PRODUCTION is what a developer's machine does (review of batch 2, M12):
 *  - the hook budgets of an installed connector: no `CROSSCHECK_TIMEOUT_MS`,
 *    so a hub request has HTTP_TIMEOUT_MS (400 ms) and each hook its ratio of
 *    it (PreToolUse 800 ms, SessionStart 1000 ms, …);
 *  - every hook a real process, started exactly as Claude Code starts
 *    `crosscheck hook <name>` (release-gate/hook-process.ts): a hook the budget
 *    cuts EXITS, abandoning what its handler had not written yet — an
 *    in-process run would let the abandoned handler finish its writes later,
 *    which no machine does;
 *  - an event's matching hooks run at once, async hooks in the background
 *    (the host does not wait for them), and subagents fan out in parallel;
 *  - the hub is warm (release-gate/hub.ts `warmHub`): a team's hub has been
 *    up for days, so a cold PGlite plan is not the product's latency.
 *
 * GENEROUS is the gate as it ran before: 4000 ms per request (10×), every
 * hook in-process and strictly one at a time. It is kept for ONE thing
 * (release-gate-generous.e2e.test.ts says which).
 *
 * LOADED is PRODUCTION on a machine whose CPUs are busy with someone else's
 * work (release-gate/burners.ts): the nightly / release-candidate lane.
 */
export type GateBudget = "production" | "generous";

export interface GateProfile {
  readonly name: "production" | "generous" | "loaded";
  readonly budget: GateBudget;
  /** Every hook a real process (production launch), an event's hooks concurrent, async hooks in the background. */
  readonly isProcessHost: boolean;
  /** Subagents fan out concurrently, as a turn that launches several Task calls at once does. */
  readonly isParallel: boolean;
  /**
   * A long session lives the way a long session does: it COMPACTS before a
   * Stop (a background subagent's Bash work lands between the turn's lane
   * and the compaction), and it ENDS and RESUMES mid-work (a VS Code reload,
   * `claude --resume`).
   */
  readonly hasCompactAndResume: boolean;
  /**
   * The person must see the collision, OR the connector must have booked,
   * inside the very moment judged, a line naming the untold warning itself —
   * a cut or unanswered tripwire (release-gate/gate-checks.ts
   * `collisionBookings`). The loaded lane's standard: under CPU starvation a
   * fail-open budget may cut, but never silently. On 5a544fff no connector
   * books such a line, so until a fix does, the loaded lane accepts nothing
   * the production lane rejects. PRODUCTION and GENEROUS require the person
   * to see it.
   */
  readonly mayBookInsteadOfWarn: boolean;
}

export const GENEROUS: GateProfile = {
  name: "generous",
  budget: "generous",
  isProcessHost: false,
  isParallel: false,
  hasCompactAndResume: false,
  mayBookInsteadOfWarn: false,
};

export const PRODUCTION: GateProfile = {
  name: "production",
  budget: "production",
  isProcessHost: true,
  isParallel: true,
  hasCompactAndResume: true,
  mayBookInsteadOfWarn: false,
};

export const LOADED: GateProfile = {
  name: "loaded",
  budget: "production",
  isProcessHost: true,
  isParallel: true,
  hasCompactAndResume: true,
  mayBookInsteadOfWarn: true,
};

/** The generous variant's per-request timeout: wide enough that a cold in-process PGlite query never trips it. */
export const GENEROUS_TIMEOUT_MS = "4000";
