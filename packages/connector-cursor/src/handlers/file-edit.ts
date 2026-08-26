/**
 * afterFileEdit (§3.2 row 2): the path — and ONLY the path — through the
 * shared target flow (repo-relative, denylist, seen-set, secret-scan, cap).
 * The `edits[]` old/new strings are file CONTENT: no schema entry parses
 * them, nothing here can store them (Tier-0 discipline; the privacy suite
 * plants sentinels and greps every disk artifact).
 *
 * THE #17 WORKTREE RESOLUTION, on this host. Until this landed, capture bound
 * `state.repoRoot` (the checkout the conversation registered at) and derived
 * every later edit's id against it, so an edit inside a LINKED WORKTREE of the
 * same repo resolved to null and was dropped — silently and uncounted, the
 * shape that produced 371 worktree edits → 0 targets on Claude Code and was
 * measured identically here. The shared flow
 * (connector-core/flows/capture-touched-files.ts) now runs ONE pre-pass per
 * event, so the git cost is paid at most once per NEW worktree root per
 * conversation (`knownWorktreeRoots`, carried across re-registrations by
 * `withCarriedCapture`) and never per edit.
 *
 * THIS IS THE ONLY CAPTURE ROW ON THIS HOST, deliberately. Cursor's
 * `postToolUse` also carries `tool_input` and its matcher vocabulary includes
 * `Write`, so it COULD capture paths — and must not: one edit would then tick
 * `editToolFires` twice and corrupt the very ratio the doctor WARN is measured
 * on. `postToolUse` stays a failure/injection row.
 *
 * NO BEFORE-EDIT TRIPWIRE IS POSSIBLE ON THIS HOST TODAY. Cursor documents no
 * `beforeFileEdit`/`beforeWrite` (cursor.com/docs/hooks, read 2026-08-26).
 * `preToolUse` does fire before a `Write`, but its only outputs are
 * `permission: "allow" | "deny"` plus messages the docs describe as shown
 * "when the action is denied"; `"ask"` is, verbatim, "accepted by the schema
 * but not enforced for `preToolUse` today", and the event has no
 * `additional_context`. So the only way to put text in front of the model
 * before an edit is to DENY it — past the ladder's structural ceiling (the
 * Claude tripwire holds exactly one decision literal, `ASK_DECISION`, and
 * three mutation entries keep deny impossible). It is not wired, and the
 * README / docs/adapters/INSTALL.md parity tables say so in those words.
 *
 * Heartbeat rides here (throttled in core), status → implementing — the
 * Claude edit-tool heuristic: an edit is the moment a session provably
 * builds.
 */
import { captureTouchedFiles } from "@crosscheck/connector-core/flows/capture-touched-files.ts";
import { heartbeatMaybe } from "@crosscheck/connector-core/flows/heartbeat.ts";
import { UNKNOWN_DEVELOPER_ID } from "@crosscheck/connector-core/capture/records.ts";
import type { Producer } from "@crosscheck/connector-core/capture/records.ts";
import { flushSpool } from "@crosscheck/connector-core/spool/flush.ts";
import { withCaptureBookkeeping } from "@crosscheck/connector-core/state/capture-bookkeeping.ts";
import {
  updateSessionState,
  withSeenTargets,
} from "@crosscheck/connector-core/state/session-state.ts";
import type { HookBudget } from "@crosscheck/connector-core/config/hook-budget.ts";

import type { CursorHookContext } from "../runner.ts";
import { IMPLEMENTING_STATUS, requireSessionState } from "./recover.ts";

/**
 * What `lastPostToolUseTool` holds for this host. The field name is
 * Claude-flavoured and stays that way — renaming it would stop old state
 * files parsing — so the honest per-host value is documented instead: this
 * event carries no `tool_name` at all, and the event name is what a doctor
 * line can truthfully print.
 */
const AFTER_FILE_EDIT_TOOL = "afterFileEdit";

export const handleAfterFileEdit = async (
  ctx: CursorHookContext,
  budget: HookBudget,
): Promise<string> => {
  // An edit event IS an edit-tool fire: booked whether or not anything is
  // captured, including on the foreign-repo path inside requireSessionState,
  // so "N fires → 0 targets" stays honest instead of reading as silence.
  const state = await requireSessionState(ctx, { editFired: true });
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
  const paths = filePath === undefined ? [] : [filePath];
  const { captured: files, resolution } = await captureTouchedFiles({
    home: ctx.config.home,
    repoKey: ctx.repoKey,
    hostSessionKey: ctx.hostSessionKey,
    repoRoot: state.repoRoot,
    // afterFileEdit documents file_path as absolute and carries no cwd of its
    // own; a relative one resolves against the event's cwd when present, the
    // workspace root else. An EMPTY cwd is treated as absent at the schema
    // boundary (payload.ts) — Cursor demonstrably sends `cwd: ""`, and `??`
    // does not fold it.
    cwd: ctx.payload.cwd ?? ctx.identity.root,
    paths,
    denylist: ctx.config.denylist ?? null,
    seenTargets: state.seenTargets,
    workContextId: state.workContextId,
    producer,
    now,
    sessionRepoId: state.repoId,
    identityRoot: ctx.identity.root,
    identityRepoId: ctx.identity.repoId,
    knownWorktreeRoots: state.knownWorktreeRoots,
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
  // Claude state-race lesson: sibling hooks overlap). The #17 root cache and
  // the #18/#20 capture counters fold in here too: ONE write per event.
  await updateSessionState(ctx.config.home, ctx.hostSessionKey, (fresh) => ({
    ...withCaptureBookkeeping(withSeenTargets(fresh, files), {
      resolution,
      capturedCount: files.length,
      editFired: true,
      toolLabel: AFTER_FILE_EDIT_TOOL,
      firstPath: paths[0] ?? null,
      now,
    }),
    ...(didHeartbeat ? { lastHeartbeatAt: now.toISOString() } : {}),
  }));
  return "";
};
