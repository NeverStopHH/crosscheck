import {
  MAX_SOLVED_POINTERS,
  MAX_TEAMMATES,
  MAX_WORK_CONTEXT_TITLE_CHARS,
} from "../constants.ts";
import { rememberDeveloper } from "../config/config.ts";
import { sanitizeUntrusted } from "../briefing/sanitize.ts";
import {
  formatSolvedLine,
  groupTeammates,
  renderBriefing,
} from "../briefing/render.ts";
import { resolveDriftByBaseCommit } from "../git/commit-drift.ts";
import { resolveDefaultBranchRef } from "../git/default-branch.ts";
import {
  collectCommitEvidence,
  commitEvidenceRecord,
} from "../capture/commit-evidence.ts";
import {
  collectLandedCommits,
  landedEvidenceRecord,
} from "../capture/landed.ts";
import {
  hintDeliveryRecord,
  UNKNOWN_DEVELOPER_ID,
  workContextRecord,
} from "../capture/records.ts";
import type { Producer } from "../capture/records.ts";
import { containsSecret } from "../capture/secret-scan.ts";
import {
  endSession,
  getAbsences,
  getContradictions,
  getPresence,
  getSolvedMatches,
  getWorkContexts,
  registerSession,
} from "../http/hub.ts";
import type { PresenceEntry, SolvedMatchEntry, WorkContextEntry } from "../http/hub.ts";
import { appendRecords } from "../spool/append.ts";
import { flushSpool } from "../spool/flush.ts";
import { reapSpool } from "../spool/reap.ts";
import type { DeferredEnder } from "../spool/reap.ts";
import {
  crosscheckSessionIdFor,
  updateSessionState,
  withBriefingSolvedRefs,
  workContextIdFor,
  writeSessionState,
} from "../state/session-state.ts";
import { writePresenceCache } from "../state/presence-cache.ts";
import type { HookBudget, HookContext } from "./runner.ts";

const INITIAL_STATUS = "analyzing";

const MS_PER_DAY = 86_400_000;

/** A resumed session whose crosscheck session was closed gets a fresh suffix. */
const RETRY_SUFFIXES = ["", "~r1", "~r2"] as const;

const HTTP_CONFLICT = 409;

interface Registration {
  readonly sessionId: string;
  readonly developerId: string | null;
}

const registerWithRetry = async (
  ctx: HookContext,
  baseId: string,
): Promise<Registration | null> => {
  for (const suffix of RETRY_SUFFIXES) {
    const sessionId = `${baseId}${suffix}`;
    const result = await registerSession(ctx.hub, {
      id: sessionId,
      agentKind: ctx.config.agentKind,
      repo: ctx.identity.repoId,
      branch: ctx.identity.branch,
      baseCommit: ctx.identity.baseCommit,
      status: INITIAL_STATUS,
    });
    if (result.ok) {
      return { sessionId, developerId: result.data.session.developerId };
    }
    if (result.status !== HTTP_CONFLICT) {
      return null;
    }
  }
  return null;
};

const LOCAL_REPO_PREFIX = "local:";

/**
 * Last segment of the shared repo id (`github.com/acme/api` → `api`), never a
 * local directory name: this title is uploaded and read by teammates. A
 * `local:` id has no shareable segment, so the branch alone has to carry it.
 */
const repoLabel = (repoId: string): string | null => {
  if (repoId.startsWith(LOCAL_REPO_PREFIX)) {
    return null;
  }
  const last = repoId.split("/").at(-1)?.trim();
  return last === undefined || last.length === 0 ? null : last;
};

/**
 * `session_title` when Claude Code supplied one, otherwise an honest derivation
 * from branch and repo id — never a fabricated task description.
 */
export const resolveWorkContextTitle = (
  sessionTitle: string | undefined,
  branch: string,
  repoId: string,
): string => {
  const label = repoLabel(repoId);
  const fallback = label === null ? branch : `${branch} @ ${label}`;
  if (sessionTitle === undefined || sessionTitle.trim().length === 0) {
    return fallback;
  }
  if (containsSecret(sessionTitle)) {
    return fallback;
  }
  const sanitized = sanitizeUntrusted(
    sessionTitle,
    MAX_WORK_CONTEXT_TITLE_CHARS,
  );
  return sanitized.length === 0 ? fallback : sanitized;
};

const selfName = (
  presence: readonly PresenceEntry[],
  developerId: string | null,
): string | null => {
  if (developerId === null) {
    return null;
  }
  const own = presence.find((entry) => entry.developerId === developerId);
  return own?.developerName ?? null;
};

/**
 * The end SessionEnd deferred, made now that reap has found the backlog gone.
 *
 * `spareMs`, never the raw remainder: this is maintenance, and the reserve
 * spare holds back is what carries the briefing out of the hook. Spending the
 * remainder here put the last hub call inside the window the total-budget race
 * fires in, and the race wins by construction — `withBudget` resolves at the
 * deadline while the handler is still finishing, so the briefing computed
 * several hundred ms earlier was thrown away. Measured through `runHook` with a
 * stranded marker, a 300 ms hub and an `end` the hub never answers: 1083 ms and
 * no briefing on the remainder, 700 ms and the full briefing on `spareMs`.
 *
 * Bounded twice even so: no call at all once the spare is gone, and a request
 * that cannot outlive what spare is left. Returning false keeps the marker, so
 * a hook out of time defers to the next SessionStart instead of dropping the
 * end — and a hub too slow to ever leave spare has that marker expired by reap
 * after MAX_SPOOL_AGE_DAYS rather than retried forever.
 */
const deferredEnder =
  (ctx: HookContext, budget: HookBudget): DeferredEnder =>
  async (crosscheckSessionId: string): Promise<boolean> => {
    const roomMs = budget.spareMs();
    if (roomMs <= 0) {
      return false;
    }
    const result = await endSession(
      { ...ctx.hub, timeoutMs: Math.min(ctx.hub.timeoutMs, roomMs) },
      crosscheckSessionId,
    );
    return result.ok;
  };

/**
 * Order is the contract here: everything the developer actually sees — the
 * session, the work context, the briefing — is done before any maintenance.
 * Every hub call the maintenance below can make is then held to `spareMs`, what
 * is left after the reserve: the drain gets it as its whole deadline, and the
 * deferred end reads it again for itself. Reap's file work is not budgeted and
 * does not need to be — it is local `readdir`/`stat`/`unlink` on a directory of
 * a few files. With the drain on a fixed ratio instead, a 600-record backlog
 * against a 350 ms hub took SessionStart to 1035 ms and returned no briefing.
 */
export const handleSessionStart = async (
  ctx: HookContext,
  budget: HookBudget,
): Promise<string> => {
  const baseSessionId = crosscheckSessionIdFor(ctx.payload.session_id);
  const registration = await registerWithRetry(ctx, baseSessionId);
  const crosscheckSessionId = registration?.sessionId ?? baseSessionId;
  const developerId = registration?.developerId ?? ctx.config.developerId;
  const workContextId = workContextIdFor(crosscheckSessionId);
  const now = ctx.now();

  const title = resolveWorkContextTitle(
    ctx.payload.session_title,
    ctx.identity.branch,
    ctx.identity.repoId,
  );
  // BEFORE the first append, always: `reap` decides that a spool file has no
  // writer left by finding no session state file for it, and that inference is
  // only sound while state is published before any record is written.
  await writeSessionState(ctx.config.home, {
    claudeSessionId: ctx.payload.session_id,
    crosscheckSessionId,
    workContextId,
    repoId: ctx.identity.repoId,
    repoRoot: ctx.identity.root,
    hubUrl: ctx.config.hubUrl,
    developerId,
    startedAt: now.toISOString(),
    lastHeartbeatAt: now.toISOString(),
    seenTargets: [],
    deliveredHintRefs: [],
    deliveredHintHashes: [],
    tripwireAskedFiles: [],
  });
  await appendRecords(
    ctx.config.home,
    ctx.repoKey,
    ctx.payload.session_id,
    [
      workContextRecord(
        { workContextId, sessionId: crosscheckSessionId, title, status: INITIAL_STATUS },
        {
          developerId: developerId ?? UNKNOWN_DEVELOPER_ID,
          agentKind: ctx.config.agentKind,
          sessionId: crosscheckSessionId,
        },
        now,
      ),
    ],
    now,
  );
  // Commit-evidence collection rides INSIDE the parallel hub-fetch block: its
  // git timeout is below the per-request hub timeout the block already waits
  // for (see COMMIT_EVIDENCE_GIT_TIMEOUT_MS), so it adds no wall clock of its
  // own — and the default-branch resolution rides the same way
  // (LANDED_GIT_TIMEOUT_MS). Absences, contradictions and solved matches are
  // three more parallel GETs under the same per-request bound — the block's
  // wall clock stays one request timeout however many rides in it. Any
  // failing costs its section, never the briefing (fail open).
  const [
    presenceResult,
    contextsResult,
    absencesResult,
    contradictionsResult,
    solvedMatchesResult,
    commitAuthors,
    defaultBranchRef,
  ] = await Promise.all([
    getPresence(ctx.hub, ctx.identity.repoId),
    getWorkContexts(ctx.hub, ctx.identity.repoId),
    getAbsences(ctx.hub, ctx.identity.repoId),
    getContradictions(ctx.hub, ctx.identity.repoId),
    getSolvedMatches(ctx.hub, ctx.identity.repoId),
    collectCommitEvidence(ctx.identity.root, now),
    resolveDefaultBranchRef(ctx.identity.root),
  ]);
  const presence = presenceResult.ok ? presenceResult.data : [];
  const workContexts = contextsResult.ok ? contextsResult.data : [];
  const absences = absencesResult.ok ? absencesResult.data : [];
  const contradictions = contradictionsResult.ok
    ? contradictionsResult.data
    : [];
  const solvedMatches = solvedMatchesResult.ok ? solvedMatchesResult.data : [];

  if (developerId !== null) {
    await rememberDeveloper(ctx.config, developerId, selfName(presence, developerId));
  }
  if (presenceResult.ok) {
    await writePresenceCache(ctx.config.home, ctx.repoKey, presence, now);
  }
  // A local append, microseconds: the maintenance flush below ships it, and a
  // dead hub leaves it spooled like any other record. Appended after the work
  // context record, so a spool replay keeps its create-before-reference order.
  if (commitAuthors !== null && commitAuthors.length > 0) {
    await appendRecords(
      ctx.config.home,
      ctx.repoKey,
      ctx.payload.session_id,
      [
        commitEvidenceRecord(
          ctx.identity.repoId,
          commitAuthors,
          {
            developerId: developerId ?? UNKNOWN_DEVELOPER_ID,
            agentKind: ctx.config.agentKind,
            sessionId: crosscheckSessionId,
          },
          now,
        ),
      ],
      now,
    );
  }

  // Only the teammates that will actually be shown cost a git process.
  const shownBaseCommits = groupTeammates(presence, now)
    .slice(0, MAX_TEAMMATES)
    .flatMap((group) => (group.baseCommit === null ? [] : [group.baseCommit]));
  // Landed detection (DESIGN.md §5): the base commits of contexts the hub
  // still lists as open. Runs IN PARALLEL with the drift fan-out — both are
  // bounded git fan-outs, so together they still cost one git timeout of
  // wall clock. No default ref resolved (fail open) = no checks.
  const openBaseCommits = workContexts.flatMap((entry: WorkContextEntry) =>
    entry.landedAt === null || entry.landedAt === undefined
      ? (entry.baseCommit === undefined ? [] : [entry.baseCommit])
      : [],
  );
  // The rotation is the day number: every SessionStart on one day probes the
  // same window (idempotent replays), and the window advances daily so a
  // backlog larger than the ancestry cap is fully covered across days
  // instead of starving its tail (capture/landed.ts).
  const landedRotation = Math.floor(now.getTime() / MS_PER_DAY);
  const [drift, landedCommits] = await Promise.all([
    resolveDriftByBaseCommit(ctx.identity.root, shownBaseCommits),
    defaultBranchRef === null || openBaseCommits.length === 0
      ? Promise.resolve([] as readonly string[])
      : collectLandedCommits(
          ctx.identity.root,
          defaultBranchRef,
          openBaseCommits,
          landedRotation,
        ),
  ]);

  const producer: Producer = {
    developerId: developerId ?? UNKNOWN_DEVELOPER_ID,
    agentKind: ctx.config.agentKind,
    sessionId: crosscheckSessionId,
  };
  // A local append, microseconds — the maintenance flush below ships it.
  if (defaultBranchRef !== null && landedCommits.length > 0) {
    await appendRecords(
      ctx.config.home,
      ctx.repoKey,
      ctx.payload.session_id,
      [
        landedEvidenceRecord(
          ctx.identity.repoId,
          defaultBranchRef,
          landedCommits,
          producer,
          now,
        ),
      ],
      now,
    );
  }

  const briefing = renderBriefing({
    repoId: ctx.identity.repoId,
    selfDeveloperId: developerId,
    presence,
    workContexts,
    now,
    drift,
    absences,
    contradictions,
    solvedMatches,
  });

  // Solved-pointer telemetry (VISION.md §1 + §4 precision loop): exactly the
  // pointers the EMITTED briefing shows — formatSolvedLine is the one
  // spelling of the line, so inclusion in the rendered text is the fact —
  // flow through hint_deliveries like every injected ref. Order matches the
  // prompt hook's contract: spool append, then state, then emit; a crash
  // between the two costs a duplicate-suppressed replay, never a repeat
  // pointer (the delivery id is deterministic per (session, ref)).
  const shownSolvedIds = solvedMatches
    .map((match: SolvedMatchEntry) => ({
      match,
      line: formatSolvedLine(match, now),
    }))
    .filter((entry) => entry.line !== null)
    .slice(0, MAX_SOLVED_POINTERS)
    .filter((entry) => briefing.includes(entry.line ?? ""))
    .map((entry) => entry.match.workContextId);
  if (shownSolvedIds.length > 0) {
    await appendRecords(
      ctx.config.home,
      ctx.repoKey,
      ctx.payload.session_id,
      shownSolvedIds.map((workContextId) =>
        hintDeliveryRecord(
          crosscheckSessionId,
          "work_context",
          workContextId,
          producer,
          now,
        ),
      ),
      now,
    );
    await updateSessionState(ctx.config.home, ctx.payload.session_id, (fresh) =>
      withBriefingSolvedRefs(fresh, shownSolvedIds),
    );
  }

  // Maintenance last, on the leftover budget: the briefing above is what this
  // hook exists for, and it is already in hand when the drain starts.
  await flushSpool(
    ctx.hub,
    { sessionId: crosscheckSessionId, developerId },
    budget.spareMs(),
  );
  // After the flush, so a session whose records just reached the hub is reaped
  // in the same run rather than a session later. Our own state file exists by
  // now, so this can never remove the file we are about to keep appending to.
  await reapSpool(
    ctx.config.home,
    ctx.repoKey,
    now,
    deferredEnder(ctx, budget),
  );

  if (briefing.length === 0) {
    return "";
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: briefing,
    },
  });
};
