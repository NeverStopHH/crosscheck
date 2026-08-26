/**
 * `assembleBriefing` (DESIGN-agent-agnostic.md §1.3) — the session-start
 * briefing recipe as an extracted function: eight parallel hub GETs → drift for
 * the teammates that will actually be shown → `renderBriefing` → the solved
 * pointers the EMITTED text really contains.
 *
 * EXTRACTED FROM `connector-claude/src/hooks/session-start.ts` for Block 5
 * (the first non-Claude injection block — the §5 scheduling note's remaining
 * entry step), not invented: the hook calls this now, and the ACP proxy's
 * async prefetch calls the same function, so the briefing a Zed-driven
 * Gemini session sees is assembled by the identical code path as a Claude
 * session's (§2.5 "rendered by the core briefing renderer").
 *
 * FAIL-OPEN EVERYWHERE, unchanged from the hook: any GET failing costs its
 * section, never the briefing; a slow git loses the drift label, never the
 * text. Wall clock is one per-request hub timeout for the parallel GET block
 * plus one bounded git fan-out (drift ∥ the optional `collectLanded` rider).
 *
 * `collectLanded` is a RIDER, not a second recipe: the Claude hook's landed
 * detection needs the fetched open contexts and must ride in parallel with
 * the drift fan-out (both bounded git fan-outs — together one git timeout of
 * wall clock, the hook's measured shape). A connector without landed
 * detection simply omits it.
 */
import {
  MAX_GHOST_POINTERS,
  MAX_SOLVED_POINTERS,
  MAX_TEAMMATES,
} from "../constants.ts";
import { formatGhostLine } from "../briefing/ghost.ts";
import {
  formatSolvedLine,
  groupTeammates,
  renderBriefing,
} from "../briefing/render.ts";
import { resolveDriftByBaseCommit } from "../git/commit-drift.ts";
import { UNKNOWN_DEVELOPER_ID, hintDeliveryRecord } from "../capture/records.ts";
import type { Producer } from "../capture/records.ts";
import {
  getAbsences,
  getContradictions,
  getDrafts,
  getGhostChecks,
  getPresence,
  getQuestions,
  getSolvedMatches,
  getWorkContexts,
} from "../http/hub.ts";
import type {
  GhostCheckEntry,
  HubContext,
  PresenceEntry,
  SolvedMatchEntry,
  WorkContextEntry,
} from "../http/hub.ts";
import { appendRecords } from "../spool/append.ts";
import {
  readSessionState,
  updateSessionState,
  withBriefingSolvedRefs,
  withGhostNotices,
} from "../state/session-state.ts";

export interface AssembleBriefingInput {
  readonly hub: HubContext;
  readonly repoId: string;
  /** Drift is resolved against this checkout; a slow git loses the label only. */
  readonly repoRoot: string;
  readonly selfDeveloperId: string | null;
  readonly now: Date;
  /**
   * Optional parallel rider over the fetched open work contexts (the Claude
   * hook's landed detection). Runs alongside the drift fan-out so it adds no
   * wall clock of its own; its result is returned untouched.
   */
  readonly collectLanded?:
    | ((workContexts: readonly WorkContextEntry[]) => Promise<readonly string[]>)
    | undefined;
}

export interface AssembledBriefing {
  /** The rendered briefing — empty means nothing worth injecting (silence). */
  readonly briefing: string;
  /**
   * Work-context ids of the solved pointers the emitted text really shows —
   * `formatSolvedLine` is the one spelling of the line, so inclusion in the
   * rendered text is the fact. These flow through hint_deliveries like every
   * injected ref (`recordBriefingDeliveries`).
   */
  readonly shownSolvedIds: readonly string[];
  readonly presence: readonly PresenceEntry[];
  /**
   * True when the presence GET succeeded — an EMPTY successful list is a
   * fact worth caching (teammates left), which `presence.length` cannot
   * distinguish from a failed fetch.
   */
  readonly presenceFetched: boolean;
  readonly workContexts: readonly WorkContextEntry[];
  /**
   * Ghost-check lines the emitted text really shows (VISION.md §3). A COUNT
   * rather than ids, because a ghost line carries no delivery record: it is
   * not news that must not repeat, it is a fact about right now that stops
   * being true when the overlap does. What the count feeds is the precision
   * half of the counter pair — how often the FREE half of this feature had
   * something to say — so it has to mean "the reader saw this" rather than
   * "the hub answered".
   */
  readonly shownGhostCount: number;
  /** The `collectLanded` rider's result; empty when no rider was passed. */
  readonly landedCommits: readonly string[];
}

export const assembleBriefing = async (
  input: AssembleBriefingInput,
): Promise<AssembledBriefing> => {
  const { hub, repoId, repoRoot, selfDeveloperId, now } = input;
  // The parallel GET block: any failing costs its section, never the briefing.
  const [
    presenceResult,
    contextsResult,
    absencesResult,
    contradictionsResult,
    solvedMatchesResult,
    draftsResult,
    questionsResult,
    ghostChecksResult,
  ] = await Promise.all([
    getPresence(hub, repoId),
    getWorkContexts(hub, repoId),
    getAbsences(hub, repoId),
    getContradictions(hub, repoId),
    getSolvedMatches(hub, repoId),
    getDrafts(hub, repoId),
    // Roadmap R2. In the SAME parallel block, so the questions block costs no
    // extra wall clock: the whole fetch is still one per-request hub timeout,
    // and a hub too old to serve it simply renders no section (fail open).
    getQuestions(hub, repoId),
    // VISION §3. Also in the parallel block, and for the same reason plus one
    // more: the SessionStart budget is 1000 ms and this GET must cost the
    // hook nothing but its share of the one timeout the block already spends.
    getGhostChecks(hub, repoId),
  ]);
  const presence = presenceResult.ok ? presenceResult.data : [];
  const workContexts = contextsResult.ok ? contextsResult.data : [];
  const absences = absencesResult.ok ? absencesResult.data : [];
  const contradictions = contradictionsResult.ok
    ? contradictionsResult.data
    : [];
  const solvedMatches = solvedMatchesResult.ok ? solvedMatchesResult.data : [];
  const drafts = draftsResult.ok ? draftsResult.data : [];
  const questions = questionsResult.ok ? questionsResult.data.inbox : [];
  const ghostChecks = ghostChecksResult.ok ? ghostChecksResult.data : [];

  // Only the teammates that will actually be shown cost a git process; the
  // optional rider shares the fan-out window, so both together still cost one
  // git timeout of wall clock (the session-start measurement).
  const shownBaseCommits = groupTeammates(presence, now)
    .slice(0, MAX_TEAMMATES)
    .flatMap((group) => (group.baseCommit === null ? [] : [group.baseCommit]));
  const [drift, landedCommits] = await Promise.all([
    resolveDriftByBaseCommit(repoRoot, shownBaseCommits),
    input.collectLanded?.(workContexts) ?? Promise.resolve([] as readonly string[]),
  ]);

  const briefing = renderBriefing({
    repoId,
    selfDeveloperId,
    presence,
    workContexts,
    now,
    drift,
    absences,
    contradictions,
    solvedMatches,
    drafts,
    questions,
    ghostChecks,
  });

  const shownSolvedIds = solvedMatches
    .map((match: SolvedMatchEntry) => ({
      match,
      line: formatSolvedLine(match, now, repoId),
    }))
    .filter((entry) => entry.line !== null)
    .slice(0, MAX_SOLVED_POINTERS)
    .filter((entry) => briefing.includes(entry.line ?? ""))
    .map((entry) => entry.match.workContextId);

  // Derived the same way the solved ids are, and for the same reason:
  // `formatGhostLine` is the one spelling of the line, so "the rendered text
  // contains it" is the fact — the section may have been dropped whole by
  // the character budget, and a counter that trusted the fetch would report
  // notices nobody saw.
  const shownGhostCount = ghostChecks
    .map((entry: GhostCheckEntry) => formatGhostLine(entry, now))
    .filter((line): line is string => line !== null)
    .slice(0, MAX_GHOST_POINTERS)
    .filter((line) => briefing.includes(line)).length;

  return {
    briefing,
    shownSolvedIds,
    shownGhostCount,
    presence,
    presenceFetched: presenceResult.ok,
    workContexts,
    landedCommits,
  };
};

export interface RecordBriefingDeliveriesInput {
  readonly home: string;
  readonly repoKey: string;
  readonly hostSessionKey: string;
  readonly crosscheckSessionId: string;
  readonly producer: Producer;
  readonly shownSolvedIds: readonly string[];
  /** Ghost lines the emitted briefing really showed (`assembleBriefing`). */
  readonly shownGhostCount: number;
  readonly now: Date;
}

/**
 * Solved-pointer telemetry for a DELIVERED briefing (VISION.md §1 + §4
 * precision loop), extracted verbatim from the session-start hook: spool the
 * hint_deliveries rows, then remember the refs in session state. Order is the
 * prompt hook's contract — append, then state, then the caller emits; a crash
 * between the two costs a duplicate-suppressed replay, never a repeat pointer
 * (the delivery id is deterministic per (session, ref), so a load/resume
 * replay re-sends the same primary key and the hub answers `duplicate`).
 */
export const recordBriefingDeliveries = async (
  input: RecordBriefingDeliveriesInput,
): Promise<void> => {
  if (input.shownSolvedIds.length === 0 && input.shownGhostCount === 0) {
    return;
  }
  // Only the SOLVED pointers become delivery rows. A ghost line is not a hint
  // — it repeats for as long as the overlap lasts, by design — so recording
  // one would make `hint_deliveries` claim a delivery nothing will ever pull.
  if (input.shownSolvedIds.length > 0) {
    await appendRecords(
      input.home,
      input.repoKey,
      input.hostSessionKey,
      input.shownSolvedIds.map((workContextId) =>
        hintDeliveryRecord(
          input.crosscheckSessionId,
          "work_context",
          workContextId,
          input.producer,
          input.now,
        ),
      ),
      input.now,
    );
  }
  // ONE state write for both counters: two would be two lock rounds on the
  // SessionStart path for one fact — what this briefing actually showed.
  await updateSessionState(input.home, input.hostSessionKey, (fresh) =>
    withGhostNotices(
      withBriefingSolvedRefs(fresh, input.shownSolvedIds),
      input.shownGhostCount,
    ),
  );
};

export interface DeliverDeferredBriefingInput {
  readonly home: string;
  readonly repoKey: string;
  readonly hub: HubContext;
  /** The host's own id for the session — the state file key. */
  readonly hostSessionKey: string;
  /** The repo THIS hook resolved; a session bound elsewhere keeps its debt. */
  readonly repoId: string;
  readonly agentKind: string;
  readonly now: Date;
}

/**
 * The ACP proxy's briefing-slot pattern in hook form (§2.5: "the cached
 * briefing on the first prompt it is ready for, the hint flow afterwards"):
 * a session that registered LATE — PostToolUse's state-less recovery, the
 * parent-workspace/finding-#9 shape — never saw SessionStart, so registration
 * left `briefingPending` in its state, and the next prompt pays the debt
 * here through the SAME `assembleBriefing` flow and renderers SessionStart
 * uses. Returns the rendered briefing, or "" (silence) — and a caller that
 * receives text emits it INSTEAD of a hint: one injection per prompt, the
 * briefing outranking the hint because it is the bigger loss.
 *
 * CLAIMED before it is assembled, exactly once: the check-and-set below is
 * the tripwire's own shape — a racing sibling reads `briefingPending: false`
 * and stays silent, so a developer can never see the same briefing twice.
 * Spending the flag on a FAILED assembly is deliberate, the ACP slot's exact
 * semantics ("a failed prefetch is an empty slot, not an error"): the
 * alternative is a six-GET retry storm on every prompt of a session whose
 * hub is down or whose repo is simply quiet. That costs one briefing in the
 * worst case — the honest direction; never a repeat, never a per-prompt tax.
 *
 * Record-then-emit still holds: the solved-pointer deliveries are spooled
 * and remembered (`recordBriefingDeliveries`) BEFORE the text is returned,
 * so the prompt path's seen-set discipline covers briefing pointers exactly
 * as it does on the SessionStart path.
 */
export const deliverDeferredBriefing = async (
  input: DeliverDeferredBriefingInput,
): Promise<string> => {
  const state = await readSessionState(input.home, input.hostSessionKey);
  if (state === null || !state.briefingPending) {
    return "";
  }
  // First-wins guard (finding #9): a prompt resolved against ANOTHER repo
  // must not spend this session's debt — the briefing belongs to the repo
  // the session is bound to, and a prompt that resolves there pays it.
  if (state.repoId !== input.repoId) {
    return "";
  }
  const claimed = await updateSessionState(
    input.home,
    input.hostSessionKey,
    (fresh) =>
      fresh.briefingPending ? { ...fresh, briefingPending: false } : null,
  );
  if (!claimed) {
    return "";
  }
  const assembled = await assembleBriefing({
    hub: input.hub,
    repoId: state.repoId,
    repoRoot: state.repoRoot,
    selfDeveloperId: state.developerId,
    now: input.now,
  });
  if (assembled.briefing.length === 0) {
    return "";
  }
  await recordBriefingDeliveries({
    home: input.home,
    repoKey: input.repoKey,
    hostSessionKey: input.hostSessionKey,
    crosscheckSessionId: state.crosscheckSessionId,
    producer: {
      developerId: state.developerId ?? UNKNOWN_DEVELOPER_ID,
      agentKind: input.agentKind,
      sessionId: state.crosscheckSessionId,
    },
    shownSolvedIds: assembled.shownSolvedIds,
    shownGhostCount: assembled.shownGhostCount,
    now: input.now,
  });
  return assembled.briefing;
};
