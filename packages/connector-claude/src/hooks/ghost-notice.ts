/**
 * THE PERSON IS TOLD about a briefing's ghost rows that share FILES with this
 * session (pilot, 2026-10-07): the briefing itself is `additionalContext`,
 * which the reference says "doesn't appear as a chat message in the
 * interface". Both hooks that emit a briefing tell the person through this
 * one door — SessionStart, and UserPromptSubmit when it pays the briefing a
 * late-registered session was owed (review L5).
 *
 * One line per teammate group (hints/collision-notice.ts), only for rows the
 * emitted briefing really shows, and only for groups this session has not
 * told its person about — a compact or resume re-fires SessionStart inside
 * the same session and keeps the record (withCarriedCapture). One locked
 * write, and none at all when no shown row has a file in it. Returns the
 * groups to TELL, not their lines: the prompt hook renders them in one bounded
 * render with a relay it emits beside them (round 2, L4). Fail open: a write
 * that failed or threw tells nobody — a group not recorded as told is not
 * told — and costs the hook nothing it emits.
 */
import { ghostCollisions } from "@crosscheck/connector-core/hints/collision-notice.ts";
import type { GhostCheckEntry } from "@crosscheck/connector-core/http/hub.ts";
import {
  newCollisionKeys,
  updateSessionState,
  withCollisionNotices,
} from "@crosscheck/connector-core/state/session-state.ts";
import type { CollisionNotice } from "@crosscheck/connector-core/state/session-state.ts";
import type { HookContext } from "./runner.ts";

export const tellPersonOfGhosts = async (
  ctx: HookContext,
  shown: readonly GhostCheckEntry[],
): Promise<readonly CollisionNotice[]> => {
  const groups = ghostCollisions(shown);
  if (groups.length === 0) {
    return [];
  }
  try {
    const told: { value: readonly CollisionNotice[] } = { value: [] };
    const written = await updateSessionState(ctx.config.home, ctx.payload.session_id, (fresh) => {
      const fresher = newCollisionKeys(fresh, groups);
      told.value = groups.filter((group) => fresher.includes(group.key));
      return withCollisionNotices(fresh, groups);
    });
    return written ? told.value : [];
  } catch {
    return [];
  }
};
