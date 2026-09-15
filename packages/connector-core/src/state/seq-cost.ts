/**
 * THE CAUSAL ORDER'S TELEMETRY, summed across live sessions for `status` and
 * `doctor` — `state/git-lane-cost.ts`'s shape, deliberately, so the two lanes
 * can never describe this machine in two different vocabularies.
 *
 * WHY THIS EXISTS AT ALL. A session whose positions are refused looks exactly
 * like a session that simply had nothing to order, and the difference decides
 * whether a fence verdict may say *whether the reason predated the change*.
 * Two failures produce that silence and neither is visible anywhere else:
 *
 *   NO EPOCH. A state file written before this protocol field allocates
 *   nothing, forever, and every record it spools carries `allocation_failed`.
 *   The session works perfectly in every other respect.
 *
 *   AN AMBIGUOUS WORKTREE. An MCP server is never told which session is
 *   calling it, so `mcp/session.ts` picks by hub, repo, worktree root and then
 *   recency — and two agent sessions in ONE worktree against one hub are
 *   indistinguishable from in there. `set_intent` is exactly the call AT-4
 *   hangs on, so the position is REFUSED rather than guessed. That refusal is
 *   correct and it is invisible: the claim lands, the intent lands, and only
 *   the order quietly stops being answerable. This is the count that says so.
 *
 * THE REMEDY IS IN THE SENTENCE, not in a document nobody opens: close one of
 * the two sessions, or give each its own worktree.
 */
import type { SessionState } from "./session-state.ts";

export interface SeqCost {
  readonly sessions: number;
  /** Sessions that can hand out positions at all. */
  readonly sequenced: number;
  /** Sessions with no epoch: every record they emit is unordered. */
  readonly unsequenced: number;
  /** Positions handed out across all live sessions — gaps included. */
  readonly allocated: number;
  /**
   * Worktree roots hosting MORE THAN ONE live session. In each of them an MCP
   * tool cannot know which session is calling, so intents and claims land
   * without a position.
   */
  readonly ambiguousRoots: number;
}

const NO_COST: SeqCost = {
  sessions: 0,
  sequenced: 0,
  unsequenced: 0,
  allocated: 0,
  ambiguousRoots: 0,
};

/**
 * THE SAME PREDICATE THE PICKER USES, from the other side.
 * `resolveOwnWorkContext` asks "does more than one eligible state file match MY
 * root"; this asks "how many roots on this machine have that shape". Keyed by
 * (hub, repo, root) because the picker filters on the first two before it
 * compares the third — the same repo on two hubs is two trust spaces.
 */
const ambiguousRootCount = (states: readonly SessionState[]): number => {
  const perRoot = new Map<string, number>();
  for (const state of states) {
    const key = `${state.hubUrl}\n${state.repoId}\n${state.repoRoot}`;
    perRoot.set(key, (perRoot.get(key) ?? 0) + 1);
  }
  return [...perRoot.values()].filter((count) => count > 1).length;
};

export const summarizeSeqCost = (states: readonly SessionState[]): SeqCost => ({
  ...states.reduce<SeqCost>(
    (total, state) => ({
      ...total,
      sessions: total.sessions + 1,
      sequenced: total.sequenced + (state.seqEpoch === null ? 0 : 1),
      unsequenced: total.unsequenced + (state.seqEpoch === null ? 1 : 0),
      allocated: total.allocated + state.eventSeq,
    }),
    NO_COST,
  ),
  ambiguousRoots: ambiguousRootCount(states),
});

/**
 * When this is worth complaining about — and NOT "any absence". A machine with
 * one healthy session per worktree warns about nothing, forever; warning there
 * would be the noise every counter in this tree is built to avoid.
 *
 * The two conditions are separate sentences because the remedies are
 * different: an unsequenced session is fixed by a newer connector having
 * written the state file, an ambiguous worktree by the person closing one of
 * the two agents.
 */
export const seqWarning = (cost: SeqCost): string | null => {
  if (cost.ambiguousRoots > 0) {
    return (
      "more than one live session shares a worktree, so an MCP tool cannot " +
      "tell which one is calling it: intents and claims still land, without a " +
      "position, and `declared before` cannot be told from `declared after` " +
      "for that work — close one of the sessions, or give each its own worktree"
    );
  }
  if (cost.unsequenced > 0) {
    return (
      "a live session has no event sequence, so everything it records is " +
      "unordered: its state file predates the sequence, and a fresh " +
      "SessionStart (a new session, or `/clear`) mints one"
    );
  }
  return null;
};

/** The one spelling both CLI surfaces print. */
export const formatSeqCost = (cost: SeqCost): string => {
  if (cost.sessions === 0) {
    return "no live sessions";
  }
  const sessions = `across ${String(cost.sessions)} live session${
    cost.sessions === 1 ? "" : "s"
  }`;
  const ambiguous =
    cost.ambiguousRoots === 0
      ? ""
      : ` · ${String(cost.ambiguousRoots)} worktree${
          cost.ambiguousRoots === 1 ? "" : "s"
        } with two sessions (MCP positions refused there)`;
  return (
    `${String(cost.allocated)} position(s) allocated · ` +
    `${String(cost.unsequenced)} with no position at all ${sessions}${ambiguous}` +
    " — order holds inside one session only: two sessions, two machines and a" +
    " CI run are not comparable by construction"
  );
};
