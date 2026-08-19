/**
 * PreToolUse tripwire (DESIGN.md §4, ask-mode): an Edit/Write to a file that
 * an ACTIVE teammate session has targeted gets a permission "ask" with a
 * factual reason — never more.
 *
 * THE LADDER STOPS AT "ask" STRUCTURALLY: this module contains exactly one
 * permission decision literal, `ASK_DECISION`, and every other branch returns
 * silence. There is no code path that could emit a deny, and
 * test/tripwire-hook.test.ts plus a mutation-check entry hold that shut.
 *
 * Everything reused, nothing re-invented: the hot-file denylist and the
 * repo-relative path logic are PostToolUse's own (capture/denylist.ts,
 * hooks/post-tool-use.ts), the self/own-worktree exclusion is the hub's
 * developer-id filter on the tripwire endpoint, and "active" is the presence
 * TTL the presence endpoint applies. One bounded hub call, one ask per file
 * per session (state file), fail-open everywhere.
 */
import { isDenied, resolveDenylist } from "@crosscheck/connector-core/capture/denylist.ts";
import { extractFilePaths, isEditTool } from "../capture/tool-events.ts";
import { getTripwireSessions } from "@crosscheck/connector-core/http/hub.ts";
import { renderTripwireReason } from "@crosscheck/connector-core/hints/render.ts";
import {
  readSessionState,
  updateSessionState,
  withTripwireAsked,
} from "@crosscheck/connector-core/state/session-state.ts";
import { toRepoRelative } from "@crosscheck/connector-core/capture/target-paths.ts";
import type { HookContext } from "./runner.ts";

/** The ONLY decision this connector can emit — the ladder's ceiling (§4). */
const ASK_DECISION = "ask";

const resolveEditedFile = async (
  ctx: HookContext,
  repoRoot: string,
): Promise<string | null> => {
  const [first] = extractFilePaths(ctx.payload.tool_input);
  if (first === undefined) {
    return null;
  }
  return toRepoRelative(repoRoot, ctx.payload.cwd, first);
};

export const handlePreToolUse = async (ctx: HookContext): Promise<string> => {
  if (!isEditTool(ctx.payload.tool_name)) {
    return "";
  }
  const state = await readSessionState(ctx.config.home, ctx.payload.session_id);
  if (state === null) {
    return "";
  }
  const file = await resolveEditedFile(ctx, state.repoRoot);
  if (file === null) {
    return "";
  }
  // Hot files drown real overlap signal — the same denylist capture applies.
  const patterns = resolveDenylist(ctx.config.denylist ?? undefined);
  if (isDenied(file, patterns)) {
    return "";
  }
  // One ask per file per session: noise budget (§10 risk 1), and the answer
  // would not change within a session anyway.
  if (state.tripwireAskedFiles.includes(file)) {
    return "";
  }
  const result = await getTripwireSessions(ctx.hub, ctx.identity.repoId, file);
  if (!result.ok) {
    return "";
  }
  const [teammate] = result.data;
  if (teammate === undefined) {
    return "";
  }
  const reason = renderTripwireReason(teammate, file, ctx.now());
  // The marker is CLAIMED atomically — check-and-set under the state lock, on
  // the freshest state: a sibling PreToolUse racing this one finds the marker
  // already present and stays silent, and a slower PostToolUse writing after
  // us can no longer erase it (test/state-race.test.ts). Claimed BEFORE
  // emitting, same honest direction as the hint delivery: a crash between the
  // two costs one ask, never a nag loop.
  const claimed = await updateSessionState(
    ctx.config.home,
    ctx.payload.session_id,
    (fresh) =>
      fresh.tripwireAskedFiles.includes(file)
        ? null
        : withTripwireAsked(fresh, file),
  );
  if (!claimed) {
    return "";
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: ASK_DECISION,
      permissionDecisionReason: reason,
    },
  });
};
