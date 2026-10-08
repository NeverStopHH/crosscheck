/**
 * `crosscheck hook turn-end` — the SYNC Stop hook (round 3, F-M2).
 *
 * WHY. Repeat edits of a collision file stopped calling the hub (round 2,
 * L1): within TRIPWIRE_RECHECK_TTL_MS of an answer this session fully dealt
 * with, an edit asks nothing. The review found the price higher than "until
 * the window passes": two edits settle a file, Ken starts on it, the rest of
 * the burst lands inside the window, and the turn moves on — no later edit
 * of the file ever asks again, and Ken is never told (probe r3d D1: four
 * edits inside the window, 0 tripwire calls, Ken never surfaced). That is
 * how the pilot's subagents edited, 91% of the time.
 *
 * WHAT. When the turn ends, the files still RESTING — at most
 * TURN_END_RECHECK_MAX_FILES of them, newest rest first — are asked about
 * again, one bounded tripwire call each, side by side. A teammate the record
 * has not told the person of is told now, as `systemMessage`, before the
 * turn is over; and a file whose fresh answer names a teammate this session
 * has not ASKED about stops resting, so its next edit asks the agent too.
 * A turn that ended long after its last rest began has nothing resting, and
 * such a file asks at its next edit, as it always did.
 *
 * WHY A SECOND Stop HOOK. The capture Stop hook is async, and Claude Code
 * shows an async hook's `systemMessage` to nobody (docs/RESEARCH.md §7). And
 * TINY BEFORE THE RUNNER: nearly every turn has nothing resting, and
 * `hasNothingToRecheck` answers those from the payload and one state read,
 * before the runner spends a config read and four git spawns.
 */
import { renderCollisionNotices, tripwireCollision } from "@crosscheck/connector-core/hints/collision-notice.ts";
import { crosscheckHome } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { TURN_END_RECHECK_MAX_FILES } from "@crosscheck/connector-core/constants.ts";
import { getTripwireSessions } from "@crosscheck/connector-core/http/hub.ts";
import type { CoverageRecord } from "@crosscheck/connector-core/http/coverage.ts";
import type { TripwireSession } from "@crosscheck/connector-core/http/hub.ts";
import {
  newCollisionKeys,
  readSessionState,
  restingFiles,
  updateSessionState,
  withCollisionNotices,
  withoutTripwireRest,
} from "@crosscheck/connector-core/state/session-state.ts";
import type { CollisionNotice, SessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { parseHookPayload } from "../capture/tool-events.ts";
import { liveAskKey, onePerKey } from "./pre-tool-use.ts";
import type { HookBudget, HookContext } from "./runner.ts";

/**
 * Whether this turn's end has nothing to ask about — answered with no git,
 * no config and no write: an unreadable payload, a Stop another stop hook
 * forced (the same turn seen twice, already asked about), or a session with
 * no file resting. Anything it cannot read for certain falls through to the
 * full hook, where asking again is only a repeat: a teammate already told is
 * never told twice.
 */
export const hasNothingToRecheck = async (stdin: string, env: Env): Promise<boolean> => {
  try {
    const payload = parseHookPayload(stdin);
    if (payload === null || payload.stop_hook_active === true) {
      return true;
    }
    const state = await readSessionState(crosscheckHome(env), payload.session_id);
    return state === null || restingFiles(state, new Date()).length === 0;
  } catch {
    return false;
  }
};

/** A resting file's fresh answer: every live teammate the hub names on it now. */
interface Recheck {
  readonly file: string;
  readonly sessions: readonly TripwireSession[];
  readonly coverage: CoverageRecord;
}

/** ONE tripwire call for one resting file, held to the request timeout and to what the budget spares; null when it gave no answer. */
const recheckOf = async (ctx: HookContext, budget: HookBudget, file: string): Promise<Recheck | null> => {
  const timeoutMs = Math.min(ctx.hub.timeoutMs, budget.spareMs());
  if (timeoutMs <= 0) {
    return null;
  }
  const result = await getTripwireSessions({ ...ctx.hub, timeoutMs }, ctx.identity.repoId, file);
  return result.ok ? { file, sessions: result.data.sessions, coverage: result.data.coverage } : null;
};

/** Whether this session has asked its agent about every teammate the fresh answer names on the file. */
const isAllAsked = (state: SessionState, recheck: Recheck): boolean =>
  recheck.sessions.every((session) => (state.tripwireAskedGroups ?? []).includes(liveAskKey(recheck.file, session)));

/** The fields a turn's end can change: nothing to write when none of them did. */
const recheckFieldsOf = (state: SessionState): string =>
  JSON.stringify([state.collisionNotices, state.tripwireCheckedFiles]);

/**
 * Every group the fresh answers name is recorded, the groups new to this
 * session are returned as the ones to tell, and a file naming a teammate the
 * agent was never asked about stops resting — in ONE locked check-and-set,
 * so a racing hook never tells the same group twice. Nothing changed,
 * nothing written.
 */
const tellAtTurnEnd = async (ctx: HookContext, rechecks: readonly Recheck[]): Promise<readonly CollisionNotice[]> => {
  const groups = onePerKey(
    rechecks.flatMap((recheck) =>
      recheck.sessions.map((session) => tripwireCollision(session, recheck.file, recheck.coverage)),
    ),
  );
  if (groups.length === 0) {
    return [];
  }
  const told: { value: readonly CollisionNotice[] } = { value: [] };
  const isWritten = await updateSessionState(ctx.config.home, ctx.payload.session_id, (fresh) => {
    const fresher = newCollisionKeys(fresh, groups);
    told.value = groups.filter((group) => fresher.includes(group.key));
    const next = rechecks.reduce(
      (state, recheck) => (isAllAsked(fresh, recheck) ? state : withoutTripwireRest(state, recheck.file)),
      withCollisionNotices(fresh, groups),
    );
    return recheckFieldsOf(next) === recheckFieldsOf(fresh) ? null : next;
  });
  return isWritten ? told.value : [];
};

export const handleTurnEnd = async (ctx: HookContext, budget: HookBudget): Promise<string> => {
  const state = await readSessionState(ctx.config.home, ctx.payload.session_id);
  if (state === null) {
    return "";
  }
  const files = restingFiles(state, ctx.now()).slice(0, TURN_END_RECHECK_MAX_FILES);
  if (files.length === 0) {
    return "";
  }
  const answered = await Promise.all(files.map((file) => recheckOf(ctx, budget, file)));
  const told = await tellAtTurnEnd(
    ctx,
    answered.filter((recheck): recheck is Recheck => recheck !== null),
  );
  return told.length === 0 ? "" : JSON.stringify({ systemMessage: renderCollisionNotices(told, ctx.now()) });
};
