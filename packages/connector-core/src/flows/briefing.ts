/**
 * `assembleBriefing` (DESIGN-agent-agnostic.md §1.3) — the session-start
 * briefing recipe as an extracted function: six parallel hub GETs → drift for
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
  CONTEXT_MAX_AGE_DAYS,
  MAX_SOLVED_POINTERS,
  MAX_TEAMMATES,
  MS_PER_DAY,
  WORK_CONTEXT_LIST_LIMIT,
} from "../constants.ts";
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
  getPresence,
  getSolvedMatches,
  getWorkContexts,
} from "../http/hub.ts";
import type {
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
  ] = await Promise.all([
    getPresence(hub, repoId),
    // The window, passed EXPLICITLY (trial finding M8): the hub's default is
    // still "everything, capped", so an older connector loses nothing, and
    // this one asks for exactly the 14 days the renderer already filters to
    // (briefing/render.ts) instead of pulling three months over a tailnet.
    getWorkContexts(hub, repoId, {
      since: new Date(
        now.getTime() - CONTEXT_MAX_AGE_DAYS * MS_PER_DAY,
      ).toISOString(),
      limit: WORK_CONTEXT_LIST_LIMIT,
    }),
    getAbsences(hub, repoId),
    getContradictions(hub, repoId),
    getSolvedMatches(hub, repoId),
    getDrafts(hub, repoId),
  ]);
  const presence = presenceResult.ok ? presenceResult.data : [];
  const workContexts = contextsResult.ok ? contextsResult.data : [];
  const absences = absencesResult.ok ? absencesResult.data : [];
  const contradictions = contradictionsResult.ok
    ? contradictionsResult.data
    : [];
  const solvedMatches = solvedMatchesResult.ok ? solvedMatchesResult.data : [];
  const drafts = draftsResult.ok ? draftsResult.data : [];

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
  });

  const shownSolvedIds = solvedMatches
    .map((match: SolvedMatchEntry) => ({
      match,
      line: formatSolvedLine(match, now),
    }))
    .filter((entry) => entry.line !== null)
    .slice(0, MAX_SOLVED_POINTERS)
    .filter((entry) => briefing.includes(entry.line ?? ""))
    .map((entry) => entry.match.workContextId);

  return {
    briefing,
    shownSolvedIds,
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
  if (input.shownSolvedIds.length === 0) {
    return;
  }
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
  await updateSessionState(input.home, input.hostSessionKey, (fresh) =>
    withBriefingSolvedRefs(fresh, input.shownSolvedIds),
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
    now: input.now,
  });
  return assembled.briefing;
};
