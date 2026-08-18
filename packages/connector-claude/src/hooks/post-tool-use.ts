import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  HEARTBEAT_MIN_INTERVAL_MS,
  MAX_TARGETS_PER_INVOCATION,
} from "@crosscheck/connector-core/constants.ts";
import { realpathBestEffort } from "@crosscheck/connector-core/config/paths.ts";
import { isDenied, resolveDenylist } from "@crosscheck/connector-core/capture/denylist.ts";
import { fingerprint } from "@crosscheck/connector-core/capture/fingerprint.ts";
import { containsSecret } from "@crosscheck/connector-core/capture/secret-scan.ts";
import {
  UNKNOWN_DEVELOPER_ID,
  targetRecord,
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
import { heartbeatSession, registerSession } from "@crosscheck/connector-core/http/hub.ts";
import { appendRecords } from "@crosscheck/connector-core/spool/append.ts";
import { flushSpool } from "@crosscheck/connector-core/spool/flush.ts";
import {
  deriveSessionState,
  readSessionState,
  updateSessionState,
  withSeenTargets,
  writeSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import type { SessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { resolveWorkContextTitle } from "./session-start.ts";
import type { HookBudget, HookContext } from "./runner.ts";

const IMPLEMENTING_STATUS = "implementing";
const HTTP_CONFLICT = 409;

/** POSIX separators on the wire: a Windows target must match a macOS one. */
const toPosix = (path: string): string => path.split(sep).join("/");

/** Exported for the PreToolUse tripwire, which asks about the same paths. */
export const toRepoRelative = async (
  repoRoot: string,
  cwd: string,
  filePath: string,
): Promise<string | null> => {
  const absolute = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
  const direct = relative(repoRoot, absolute);
  if (direct.length > 0 && !direct.startsWith("..") && !isAbsolute(direct)) {
    return toPosix(direct);
  }
  const resolvedRoot = await realpathBestEffort(repoRoot);
  const resolvedFile = await realpathBestEffort(absolute);
  const viaRealpath = relative(resolvedRoot, resolvedFile);
  if (
    viaRealpath.length === 0 ||
    viaRealpath.startsWith("..") ||
    isAbsolute(viaRealpath)
  ) {
    return null;
  }
  return toPosix(viaRealpath);
};

const collectFileTargets = async (
  ctx: HookContext,
  state: SessionState,
): Promise<readonly string[]> => {
  const patterns = resolveDenylist(ctx.config.denylist ?? undefined);
  const seen = new Set(state.seenTargets);
  const paths = extractFilePaths(ctx.payload.tool_input);
  const collected: string[] = [];
  for (const path of paths) {
    if (collected.length >= MAX_TARGETS_PER_INVOCATION) {
      break;
    }
    const relativePath = await toRepoRelative(
      state.repoRoot,
      ctx.payload.cwd,
      path,
    );
    if (relativePath === null || isDenied(relativePath, patterns)) {
      continue;
    }
    if (containsSecret(relativePath) || seen.has(relativePath)) {
      continue;
    }
    seen.add(relativePath);
    collected.push(relativePath);
  }
  return collected;
};

const collectFingerprint = (ctx: HookContext): string | null => {
  if (!isFailureResponse(ctx.payload.tool_response)) {
    return null;
  }
  const text = extractFailureText(ctx.payload.tool_response);
  return text.length === 0 ? null : fingerprint(text);
};

const shouldHeartbeat = (state: SessionState, now: Date): boolean => {
  if (state.lastHeartbeatAt === null) {
    return true;
  }
  const lastMs = Date.parse(state.lastHeartbeatAt);
  return (
    Number.isNaN(lastMs) || now.getTime() - lastMs >= HEARTBEAT_MIN_INTERVAL_MS
  );
};

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
    claudeSessionId: ctx.payload.session_id,
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
  // A conflict means the id belongs to somebody else — nothing to recover.
  if (!result.ok && result.status === HTTP_CONFLICT) {
    return null;
  }
  const developerId = result.ok
    ? result.data.session.developerId
    : ctx.config.developerId;
  const now = ctx.now();
  const recovered: SessionState = { ...derived, developerId };
  // BEFORE the first append, always: `reap` infers "no writer left" from the
  // absence of a session state file, so a hook that appends without publishing
  // state first could have its records reaped out from under it.
  await writeSessionState(ctx.config.home, recovered);
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

const maybeHeartbeat = async (
  ctx: HookContext,
  state: SessionState,
  now: Date,
): Promise<boolean> => {
  const toolName = ctx.payload.tool_name;
  if (!isEditTool(toolName) && !isBashTool(toolName)) {
    return false;
  }
  if (!shouldHeartbeat(state, now)) {
    return false;
  }
  await heartbeatSession(
    ctx.hub,
    state.crosscheckSessionId,
    heartbeatStatusFor(toolName),
  );
  return true;
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

  const now = ctx.now();
  const producer: Producer = {
    developerId: state.developerId ?? UNKNOWN_DEVELOPER_ID,
    agentKind: ctx.config.agentKind,
    sessionId: state.crosscheckSessionId,
  };
  const files = await collectFileTargets(ctx, state);
  const errorFingerprint = collectFingerprint(ctx);
  const records = [
    ...files.map((value) =>
      targetRecord(state.workContextId, "file", value, producer, now),
    ),
    ...(errorFingerprint === null
      ? []
      : [
          targetRecord(
            state.workContextId,
            "error_fingerprint",
            errorFingerprint,
            producer,
            now,
          ),
        ]),
  ];

  if (records.length > 0) {
    await appendRecords(
      ctx.config.home,
      ctx.repoKey,
      ctx.payload.session_id,
      records,
      now,
    );
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
