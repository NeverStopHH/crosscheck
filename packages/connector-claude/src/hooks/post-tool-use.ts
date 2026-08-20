import {
  UNKNOWN_DEVELOPER_ID,
  workContextRecord,
} from "@crosscheck/connector-core/capture/records.ts";
import type { Producer } from "@crosscheck/connector-core/capture/records.ts";
import {
  extractFailureText,
  extractFilePaths,
  isBashTool,
  isEditTool,
  isFailureResponse,
} from "../capture/tool-events.ts";
import {
  captureFailure,
  captureFileTargets,
} from "@crosscheck/connector-core/flows/capture-targets.ts";
import { heartbeatMaybe } from "@crosscheck/connector-core/flows/heartbeat.ts";
import { registerSession } from "@crosscheck/connector-core/http/hub.ts";
import { appendRecords } from "@crosscheck/connector-core/spool/append.ts";
import { flushSpool } from "@crosscheck/connector-core/spool/flush.ts";
import {
  claimSessionState,
  deriveSessionState,
  readSessionState,
  updateSessionState,
  withSeenTargets,
} from "@crosscheck/connector-core/state/session-state.ts";
import type { SessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { resolveWorkContextTitle } from "./session-start.ts";
import type { HookBudget, HookContext } from "./runner.ts";

const IMPLEMENTING_STATUS = "implementing";
const HTTP_CONFLICT = 409;

/**
 * A hook installed mid-session has no state file. The ids are deterministic, so
 * re-registering reconstructs exactly what SessionStart would have created.
 *
 * The work-context envelope is spooled whether or not the hub answered: an
 * unreachable hub is precisely what the spool exists for, and targets spooled
 * against a work context that was never recorded are rejected forever.
 */
const recoverState = async (ctx: HookContext): Promise<SessionState | null> => {
  const derived = deriveSessionState({
    hostSessionKey: ctx.payload.session_id,
    repoId: ctx.identity.repoId,
    repoRoot: ctx.identity.root,
    hubUrl: ctx.config.hubUrl,
    developerId: ctx.config.developerId,
    startedAt: ctx.now().toISOString(),
  });
  const result = await registerSession(ctx.hub, {
    id: derived.crosscheckSessionId,
    agentKind: ctx.config.agentKind,
    repo: ctx.identity.repoId,
    branch: ctx.identity.branch,
    baseCommit: ctx.identity.baseCommit,
    status: IMPLEMENTING_STATUS,
  });
  // A conflict means the id belongs to somebody else, OR to a live session
  // this developer already bound to ANOTHER repo (the hub's repo_mismatch,
  // first-wins) — either way, nothing to recover.
  if (!result.ok && result.status === HTTP_CONFLICT) {
    return null;
  }
  const developerId = result.ok
    ? result.data.session.developerId
    : ctx.config.developerId;
  const now = ctx.now();
  // `briefingPending`: a recovery registration means SessionStart never ran
  // for this session (or ran somewhere it could not resolve the repo — the
  // parent-workspace shape), so nobody has briefed it. The debt is recorded
  // here and paid by the NEXT UserPromptSubmit through the same core flow
  // SessionStart uses (flows/briefing.ts `deliverDeferredBriefing`) — a
  // parent-workspace session loses nothing but the timing.
  const recovered: SessionState = {
    ...derived,
    developerId,
    briefingPending: true,
  };
  // BEFORE the first append, always: `reap` infers "no writer left" from the
  // absence of a session state file, so a hook that appends without publishing
  // state first could have its records reaped out from under it.
  //
  // CLAIMED, never overwritten (recovery-race.test.ts): a sibling recovery
  // that published state during our register round-trip keeps its binding —
  // we adopt it (the caller's foreign-repo guard judges the repo) and append
  // no second work context. A busy lock is fail-open silence.
  const claim = await claimSessionState(ctx.config.home, recovered);
  if (claim === null) {
    return null;
  }
  if (!claim.claimed) {
    return claim.state;
  }
  // The work context must exist before its targets, or ingest rejects them.
  await appendRecords(
    ctx.config.home,
    ctx.repoKey,
    ctx.payload.session_id,
    [
      workContextRecord(
        {
          workContextId: derived.workContextId,
          sessionId: derived.crosscheckSessionId,
          title: resolveWorkContextTitle(
            undefined,
            ctx.identity.branch,
            ctx.identity.repoId,
          ),
          status: IMPLEMENTING_STATUS,
        },
        {
          developerId: developerId ?? UNKNOWN_DEVELOPER_ID,
          agentKind: ctx.config.agentKind,
          sessionId: derived.crosscheckSessionId,
        },
        now,
      ),
    ],
    now,
  );
  return recovered;
};

/** Bash carries no status signal, so none is fabricated (spec §C). */
const heartbeatStatusFor = (toolName: string | undefined): string | undefined =>
  isEditTool(toolName) ? IMPLEMENTING_STATUS : undefined;

/** Claude's heartbeat POLICY (which tools may beat); the throttle is core's. */
const maybeHeartbeat = async (
  ctx: HookContext,
  state: SessionState,
  now: Date,
): Promise<boolean> => {
  const toolName = ctx.payload.tool_name;
  if (!isEditTool(toolName) && !isBashTool(toolName)) {
    return false;
  }
  return heartbeatMaybe({
    hub: ctx.hub,
    crosscheckSessionId: state.crosscheckSessionId,
    lastHeartbeatAt: state.lastHeartbeatAt,
    now,
    status: heartbeatStatusFor(toolName),
  });
};

export const handlePostToolUse = async (
  ctx: HookContext,
  budget: HookBudget,
): Promise<string> => {
  const stored = await readSessionState(ctx.config.home, ctx.payload.session_id);
  const state = stored ?? (await recoverState(ctx));
  if (state === null) {
    return "";
  }

  // FIRST WINS across connected repos (trial finding #9): one agent session
  // is ONE crosscheck session, bound at registration to one repo — the
  // session model has a single repo column, reap keys one state file per
  // host session, and the deterministic cc_<session> id cannot exist twice.
  // A touch resolving to a DIFFERENT repo (multi-project workspace, or a
  // mid-session cd) is therefore dropped and COUNTED, never captured under
  // the wrong repo and never re-homing the session: capture, heartbeat and
  // flush all belong to the repo this hook resolved, which is not the one
  // this session reports to. The count is what keeps the drop honest.
  if (state.repoId !== ctx.identity.repoId) {
    await updateSessionState(ctx.config.home, ctx.payload.session_id, (fresh) => ({
      ...fresh,
      foreignRepoDrops: fresh.foreignRepoDrops + 1,
    }));
    return "";
  }

  const now = ctx.now();
  const producer: Producer = {
    developerId: state.developerId ?? UNKNOWN_DEVELOPER_ID,
    agentKind: ctx.config.agentKind,
    sessionId: state.crosscheckSessionId,
  };
  // The §1.3 flows (flows/capture-targets.ts): targets first, then the
  // fingerprint — the same spool order the combined batch used to produce.
  // Claude-side stays exactly the payload parsing: which fields carry paths,
  // what counts as a failure response.
  const files = await captureFileTargets({
    home: ctx.config.home,
    repoKey: ctx.repoKey,
    hostSessionKey: ctx.payload.session_id,
    repoRoot: state.repoRoot,
    cwd: ctx.payload.cwd,
    paths: extractFilePaths(ctx.payload.tool_input),
    denylist: ctx.config.denylist ?? null,
    seenTargets: state.seenTargets,
    workContextId: state.workContextId,
    producer,
    now,
  });
  if (isFailureResponse(ctx.payload.tool_response)) {
    await captureFailure({
      home: ctx.config.home,
      repoKey: ctx.repoKey,
      hostSessionKey: ctx.payload.session_id,
      workContextId: state.workContextId,
      producer,
      failureText: extractFailureText(ctx.payload.tool_response),
      now,
    });
  }
  // `spareMs`, not the whole remainder: the heartbeat below is another hub call
  // and the state write after it is what keeps this session's spool safe.
  await flushSpool(
    ctx.hub,
    {
      sessionId: state.crosscheckSessionId,
      developerId: state.developerId,
    },
    budget.spareMs(),
  );

  const didHeartbeat = await maybeHeartbeat(ctx, state, now);
  // Transform the FRESHEST state under the lock, never write back the whole
  // snapshot read before the flush: a sibling PreToolUse recorded its
  // tripwire marker inside this hook's window, and a stale whole-file write
  // here would erase it (test/state-race.test.ts).
  await updateSessionState(ctx.config.home, ctx.payload.session_id, (fresh) => ({
    ...withSeenTargets(fresh, files),
    ...(didHeartbeat ? { lastHeartbeatAt: now.toISOString() } : {}),
  }));
  return "";
};
