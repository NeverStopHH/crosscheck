/**
 * afterFileEdit (§3.2 row 2): the path — and ONLY the path — through the
 * shared target flow (repo-relative, denylist, seen-set, secret-scan, cap).
 * The `edits[]` old/new strings are file CONTENT: no schema entry parses
 * them, nothing here can store them (Tier-0 discipline; the privacy suite
 * plants sentinels and greps every disk artifact).
 *
 * Heartbeat rides here (throttled in core), status → implementing — the
 * Claude edit-tool heuristic: an edit is the moment a session provably
 * builds.
 */
import {
  captureFileTargets,
} from "@crosscheck/connector-core/flows/capture-targets.ts";
import { heartbeatMaybe } from "@crosscheck/connector-core/flows/heartbeat.ts";
import { UNKNOWN_DEVELOPER_ID } from "@crosscheck/connector-core/capture/records.ts";
import type { Producer } from "@crosscheck/connector-core/capture/records.ts";
import { flushSpool } from "@crosscheck/connector-core/spool/flush.ts";
import {
  updateSessionState,
  withSeenTargets,
} from "@crosscheck/connector-core/state/session-state.ts";
import type { HookBudget } from "@crosscheck/connector-core/config/hook-budget.ts";

import type { CursorHookContext } from "../runner.ts";
import { IMPLEMENTING_STATUS, requireSessionState } from "./recover.ts";

export const handleAfterFileEdit = async (
  ctx: CursorHookContext,
  budget: HookBudget,
): Promise<string> => {
  const state = await requireSessionState(ctx);
  if (state === null) {
    return "";
  }
  const now = ctx.now();
  const producer: Producer = {
    developerId: state.developerId ?? UNKNOWN_DEVELOPER_ID,
    agentKind: ctx.config.agentKind,
    sessionId: state.crosscheckSessionId,
  };
  const filePath = ctx.payload.file_path;
  const files = await captureFileTargets({
    home: ctx.config.home,
    repoKey: ctx.repoKey,
    hostSessionKey: ctx.hostSessionKey,
    repoRoot: state.repoRoot,
    // afterFileEdit documents file_path as absolute; a relative one resolves
    // against the event's own cwd when present, the workspace root else.
    cwd: ctx.payload.cwd ?? ctx.identity.root,
    paths: filePath === undefined ? [] : [filePath],
    denylist: ctx.config.denylist ?? null,
    seenTargets: state.seenTargets,
    workContextId: state.workContextId,
    producer,
    now,
  });
  // Claude's PostToolUse hosts capture + drain + heartbeat in one event;
  // Cursor splits the event, each split keeps the drain — `spareMs`, not the
  // raw remainder: the heartbeat below is another hub call and the state
  // write after it is what keeps this session's spool safe.
  await flushSpool(
    ctx.hub,
    { sessionId: state.crosscheckSessionId, developerId: state.developerId },
    budget.spareMs(),
  );
  const didHeartbeat = await heartbeatMaybe({
    hub: ctx.hub,
    crosscheckSessionId: state.crosscheckSessionId,
    lastHeartbeatAt: state.lastHeartbeatAt,
    now,
    status: IMPLEMENTING_STATUS,
  });
  // Freshest state under the lock — never the snapshot read above (the
  // Claude state-race lesson: sibling hooks overlap).
  await updateSessionState(ctx.config.home, ctx.hostSessionKey, (fresh) => ({
    ...withSeenTargets(fresh, files),
    ...(didHeartbeat ? { lastHeartbeatAt: now.toISOString() } : {}),
  }));
  return "";
};
