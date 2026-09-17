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
 *   A BROKEN EPOCH. Two events that claimed one position, or one session
 *   holding two counters. Neither is visible from here at all — both are facts
 *   about rows the hub holds — so the hub's own answer is carried in beside
 *   the local counts rather than guessed at from a state file that cannot know.
 *   It costs the WHOLE session: every happens-before question about it is
 *   refused, including the half that was perfectly ordered.
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
  /**
   * TOOL WINDOWS THE CAP EVICTED, summed across live sessions — an UPPER
   * BOUND on the brackets lost, not a count of them. A call that was still
   * running when its window went lost the floor its own PreToolUse paid for,
   * so its edit reaches the hub as the upper bound it always was and every
   * happens-before question against it is refused. A call that had already
   * ended with no hook left to close its window — denied, or aborted — lost
   * nothing, and nothing here can tell the two apart. Failed edits are not in
   * either group: PostToolUseFailure closes their windows.
   *
   * IT IS NOT A WARNING and it has no remedy a reader could act on:
   * MAX_TOOL_WINDOWS is a limit of this build, the eviction costs only
   * precision, and this tree's rule for a platform limit nobody can act on is
   * that it stays PASS and is stated. It is COUNTED because the cap is a
   * CHOSEN number and a real install reaching the ceiling is the only
   * evidence that can say it is too small. A missing bracket on its own
   * cannot say it: it looks identical to a call that opened no window.
   */
  readonly windowEvictions: number;
}

const NO_COST: SeqCost = {
  sessions: 0,
  sequenced: 0,
  unsequenced: 0,
  allocated: 0,
  ambiguousRoots: 0,
  windowEvictions: 0,
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
      windowEvictions: total.windowEvictions + state.toolWindowEvictions,
    }),
    NO_COST,
  ),
  ambiguousRoots: ambiguousRootCount(states),
});

/**
 * ONE SESSION THE HUB CANNOT ORDER — the shape `getBrokenSessionOrders`
 * returns, narrowed to what a line prints. `null` means the hub was not asked
 * or did not answer, which is NOT the same as "none broken" and must not be
 * printed as though it were.
 */
export interface BrokenOrder {
  readonly sessionId: string;
  readonly reason: string;
}

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
export const seqWarning = (
  cost: SeqCost,
  broken: readonly BrokenOrder[] | null = null,
): string | null => {
  // FIRST, because it is the only one that costs a WHOLE session. The other
  // two withhold positions from records the connector has not emitted yet; a
  // broken epoch retires every comparison in a session that already ran.
  if (broken !== null && broken.length > 0) {
    return (
      `the hub cannot order ${plural(broken.length, "session")} of yours ` +
      `(${reasonsOf(broken)}): two events claimed one position, or the ` +
      "session minted a second counter — every `declared before` question " +
      "about that session is refused, including the part that was ordered " +
      "correctly, and a fresh session (a new one, or `/clear`) starts a " +
      "sequence that is whole"
    );
  }
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

const plural = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? "" : "s"}`;

/** The reasons behind a broken count, de-duplicated and in a stable order. */
const reasonsOf = (broken: readonly BrokenOrder[]): string =>
  [...new Set(broken.map((order) => order.reason))].sort().join(", ");

/** The one spelling both CLI surfaces print. */
export const formatSeqCost = (
  cost: SeqCost,
  broken: readonly BrokenOrder[] | null = null,
): string => {
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
  // Silent at zero, like the two above it: an eviction is rare by
  // construction, and "0 evicted" on every healthy machine forever is the
  // noise this line is built to avoid. Above zero it says what an eviction
  // CAN cost — a bracket, never a record, because the records landed — and
  // that it may have cost nothing, because the count cannot tell which.
  const evicted =
    cost.windowEvictions === 0
      ? ""
      : ` · ${String(cost.windowEvictions)} tool window(s) evicted at the cap (an edit still running when its window went travels as an upper bound; a call that had already ended lost nothing)`;
  // ABSENT IS NOT ZERO. A hub too old for the route, or one that did not
  // answer, says nothing — and printing "0 broken" there would be an assertion
  // nobody made. The line stays silent about what it could not ask.
  const hub =
    broken === null || broken.length === 0
      ? ""
      : ` · ${plural(broken.length, "session")} on the hub cannot be ordered (${reasonsOf(broken)})`;
  return (
    `${String(cost.allocated)} position(s) allocated · ` +
    `${String(cost.unsequenced)} with no position at all ${sessions}${ambiguous}${evicted}${hub}` +
    " — order holds inside one session only: two sessions, two machines and a" +
    " CI run are not comparable by construction"
  );
};
