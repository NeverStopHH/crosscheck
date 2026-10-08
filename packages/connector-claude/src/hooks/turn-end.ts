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
 * WHAT. Every rest owes a recheck (hooks/rest-recheck.ts). When the turn
 * ends, this hook pays the debts — at most TURN_END_RECHECK_MAX_FILES of
 * them, newest rest first, one bounded tripwire call each, side by side. A
 * teammate the record has not told the person of is told now, as
 * `systemMessage`, before the turn is over, and a paid file rests no more,
 * so its next edit asks the hub again. A debt it could not pay — past the
 * cap, out of budget, unanswered — is KEPT, and the next hook that finds its
 * rest over pays it or books it as a loss: the cap never drops one.
 *
 * WHY A SECOND Stop HOOK. The capture Stop hook is async, and Claude Code
 * shows an async hook's `systemMessage` to nobody (docs/RESEARCH.md §7). And
 * TINY BEFORE THE RUNNER: nearly every turn owes nothing, and
 * `hasNothingToRecheck` answers those from the payload and one state read,
 * before the runner spends a config read and four git spawns.
 */
import { renderCollisionNotices } from "@crosscheck/connector-core/hints/collision-notice.ts";
import { crosscheckHome } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { TURN_END_HOOK, TURN_END_RECHECK_MAX_FILES } from "@crosscheck/connector-core/constants.ts";
import { owedRests, readSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { parseHookPayload } from "../capture/tool-events.ts";
import { hasOwedRests, recheckRests } from "./rest-recheck.ts";
import type { HookBudget, HookContext } from "./runner.ts";

/**
 * Whether this turn's end has nothing to ask about — answered with no git,
 * no config and no write: an unreadable payload, a Stop another stop hook
 * forced (the same turn seen twice, already asked about), or a session that
 * owes no recheck. Anything it cannot read for certain falls through to the
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
    return state === null || !hasOwedRests(state);
  } catch {
    return false;
  }
};

export const handleTurnEnd = async (ctx: HookContext, budget: HookBudget): Promise<string> => {
  const state = await readSessionState(ctx.config.home, ctx.payload.session_id);
  if (state === null) {
    return "";
  }
  const told = await recheckRests(ctx, budget, owedRests(state).slice(0, TURN_END_RECHECK_MAX_FILES), {
    detail: TURN_END_HOOK,
    onFailure: "keep",
  });
  return told.length === 0 ? "" : JSON.stringify({ systemMessage: renderCollisionNotices(told, ctx.now()) });
};
