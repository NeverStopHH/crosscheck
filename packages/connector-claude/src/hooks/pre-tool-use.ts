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
  withKnownWorktreeRoot,
  withTripwireAsked,
} from "@crosscheck/connector-core/state/session-state.ts";
import type { SessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { resolveTouchedRoots } from "@crosscheck/connector-core/capture/touched-root.ts";
import { toRepoRelative } from "@crosscheck/connector-core/capture/target-paths.ts";
import { resolveTripwireMode } from "@crosscheck/connector-core/config/tripwire.ts";
import { TRIPWIRE_MODE_NOTICE } from "@crosscheck/connector-core/constants.ts";
import type { HookContext } from "./runner.ts";

/** The ONLY decision this connector can emit — the ladder's ceiling (§4). */
const ASK_DECISION = "ask";

/**
 * The edited file's repo-relative id, resolved against the root that governs
 * the FILE (trial finding #17): PostToolUse's own resolution, so an edit in a
 * linked worktree of the same repo trips the wire instead of resolving to null
 * against the session's checkout. A newly-resolved worktree root is persisted
 * to the session-state cache so pre- and post-tool-use never pay git twice for
 * it (hook budgets are binding).
 */
const resolveEditedFile = async (
  ctx: HookContext,
  state: SessionState,
): Promise<string | null> => {
  const [first] = extractFilePaths(ctx.payload.tool_input);
  if (first === undefined) {
    return null;
  }
  const resolution = await resolveTouchedRoots({
    paths: [first],
    cwd: ctx.payload.cwd,
    sessionRepoRoot: state.repoRoot,
    sessionRepoId: state.repoId,
    identityRoot: ctx.identity.root,
    identityRepoId: ctx.identity.repoId,
    knownWorktreeRoots: state.knownWorktreeRoots,
  });
  if (resolution.newlyResolved.length > 0) {
    await updateSessionState(ctx.config.home, ctx.payload.session_id, (fresh) =>
      resolution.newlyResolved.reduce(
        (next, entry) => withKnownWorktreeRoot(next, entry.root, entry.repoId),
        fresh,
      ),
    );
  }
  const root = resolution.rootByPath.get(first);
  return root === undefined
    ? null
    : toRepoRelative(root, ctx.payload.cwd, first);
};

export const handlePreToolUse = async (ctx: HookContext): Promise<string> => {
  if (!isEditTool(ctx.payload.tool_name)) {
    return "";
  }
  const state = await readSessionState(ctx.config.home, ctx.payload.session_id);
  if (state === null) {
    return "";
  }
  const file = await resolveEditedFile(ctx, state);
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
  const mode = resolveTripwireMode(ctx.env);
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
  // #25: additionalContext carries the SAME factual reason (incl. the
  // get_diagnosis id) to the MODEL — permissionDecisionReason for an "ask"
  // reaches the human only (hooks.md), so before this the model learned
  // nothing. It is emitted in BOTH modes. In `notice` mode (Q2: headless
  // orchestration/CI) the decision fields are omitted entirely, so the tool is
  // briefed but never blocked — the only honest fallback, since headless
  // cannot be auto-detected. The ladder still stops at "ask": ASK_DECISION is
  // this module's one decision literal and `notice` emits no decision at all.
  const hookSpecificOutput =
    mode === TRIPWIRE_MODE_NOTICE
      ? { hookEventName: "PreToolUse", additionalContext: reason }
      : {
          hookEventName: "PreToolUse",
          permissionDecision: ASK_DECISION,
          permissionDecisionReason: reason,
          additionalContext: reason,
        };
  return JSON.stringify({ hookSpecificOutput });
};
