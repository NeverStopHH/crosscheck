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
import { MAX_SOLVED_POINTERS, MAX_TEAMMATES } from "../constants.ts";
import {
  formatSolvedLine,
  groupTeammates,
  renderBriefing,
} from "../briefing/render.ts";
import { resolveDriftByBaseCommit } from "../git/commit-drift.ts";
import { hintDeliveryRecord } from "../capture/records.ts";
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
    getWorkContexts(hub, repoId),
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
