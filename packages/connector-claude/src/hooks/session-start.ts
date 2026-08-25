import {
  HTTP_NOT_FOUND,
  MAX_WORK_CONTEXT_TITLE_CHARS,
} from "@crosscheck/connector-core/constants.ts";
import { rememberDeveloper } from "@crosscheck/connector-core/config/config.ts";
import { sanitizeUntrusted } from "@crosscheck/connector-core/briefing/sanitize.ts";
import { resolveDefaultBranchRef } from "@crosscheck/connector-core/git/default-branch.ts";
import {
  collectCommitEvidence,
  commitEvidenceRecord,
} from "@crosscheck/connector-core/capture/commit-evidence.ts";
import {
  collectLandedCommits,
  landedEvidenceRecord,
} from "@crosscheck/connector-core/capture/landed.ts";
import { UNKNOWN_DEVELOPER_ID } from "@crosscheck/connector-core/capture/records.ts";
import type { Producer } from "@crosscheck/connector-core/capture/records.ts";
import { containsSecret } from "@crosscheck/connector-core/capture/secret-scan.ts";
import { endSession } from "@crosscheck/connector-core/http/hub.ts";
import type { PresenceEntry, WorkContextEntry } from "@crosscheck/connector-core/http/hub.ts";
import {
  assembleBriefing,
  recordBriefingDeliveries,
} from "@crosscheck/connector-core/flows/briefing.ts";
import {
  fallbackWorkContextTitle,
  registerSessionFlow,
} from "@crosscheck/connector-core/flows/register-session.ts";
import { appendRecords } from "@crosscheck/connector-core/spool/append.ts";
import { flushSpool } from "@crosscheck/connector-core/spool/flush.ts";
import {
  hasSpendablePendingEnd,
  reapSpool,
} from "@crosscheck/connector-core/spool/reap.ts";
import type {
  DeferredEndOutcome,
  DeferredEnder,
} from "@crosscheck/connector-core/spool/reap.ts";
import {
  deriveLastSeen,
  writePresenceCache,
} from "@crosscheck/connector-core/state/presence-cache.ts";
import { reapStaleSessionStates } from "@crosscheck/connector-core/state/session-reap.ts";
import type { HookBudget, HookContext } from "./runner.ts";

const INITIAL_STATUS = "analyzing";

/**
 * Whether this session is sitting ON the default branch (or detached), so its
 * base commit is an ancestor of the default ref by construction rather than by
 * having landed anything (Anhang A, A5-9).
 *
 * `defaultBranchRef` is a REMOTE-tracking ref — `origin/main` — while
 * `identity.branch` is the local name, so the comparison is against the
 * segment after the remote. A detached HEAD renders as `detached@<sha>`
 * (git/repo-identity.ts resolveBranch) and counts too: an orchestration
 * worktree detached at a commit the default branch already contains is an
 * ancestor of it forever, and every context it opens would be born landed.
 */
export const isOnDefaultBranch = (
  branch: string,
  defaultBranchRef: string | null,
): boolean => {
  if (branch.startsWith("detached@") || branch === "HEAD") {
    return true;
  }
  if (defaultBranchRef === null) {
    return false;
  }
  const localName = defaultBranchRef.split("/").at(-1) ?? defaultBranchRef;
  return branch === localName || branch === defaultBranchRef;
};

const MS_PER_DAY = 86_400_000;

/**
 * `session_title` when Claude Code supplied one, otherwise the honest core
 * fallback derived from branch and repo id (`flows/register-session.ts`) —
 * never a fabricated task description.
 */
export const resolveWorkContextTitle = (
  sessionTitle: string | undefined,
  branch: string,
  repoId: string,
): string => {
  const fallback = fallbackWorkContextTitle(branch, repoId);
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
  async (crosscheckSessionId: string): Promise<DeferredEndOutcome> => {
    const roomMs = budget.spareMs();
    if (roomMs <= 0) {
      return "retry";
    }
    const result = await endSession(
      { ...ctx.hub, timeoutMs: Math.min(ctx.hub.timeoutMs, roomMs) },
      crosscheckSessionId,
    );
    if (result.ok) {
      return "ended";
    }
    // A 404 is TERMINAL for a deferred end (trial finding M6): the hub has
    // never heard of this session — the failed-first-register shape — so
    // there is nothing to end and no later attempt can change that. Retrying
    // it cost a hub call on every SessionStart until the marker aged out
    // seven days later; the trial machine was carrying one 48 hours old.
    //
    // SCOPE: this is the DEFERRED-end path only. A 404 on a LIVE session's
    // heartbeat means something else entirely (re-register), and that ladder
    // belongs to the capture branch — `flows/heartbeat.ts` is untouched here.
    return result.status === HTTP_NOT_FOUND ? "gone" : "retry";
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
  const now = ctx.now();
  const title = resolveWorkContextTitle(
    ctx.payload.session_title,
    ctx.identity.branch,
    ctx.identity.repoId,
  );
  // The §1.3 flow: register (+409 retry) → state file BEFORE any append
  // (reap's aliveness invariant) → work-context record. One implementation,
  // shared with every connector (flows/register-session.ts).
  const { crosscheckSessionId, workContextId, developerId } =
    await registerSessionFlow({
      home: ctx.config.home,
      repoKey: ctx.repoKey,
      hub: ctx.hub,
      agentKind: ctx.config.agentKind,
      hostSessionKey: ctx.payload.session_id,
      repoId: ctx.identity.repoId,
      repoRoot: ctx.identity.root,
      branch: ctx.identity.branch,
      baseCommit: ctx.identity.baseCommit,
      hubUrl: ctx.config.hubUrl,
      fallbackDeveloperId: ctx.config.developerId,
      title,
      status: INITIAL_STATUS,
      now,
    });
  // Commit-evidence collection and default-branch resolution START here and
  // resolve DURING the flow's parallel hub-fetch block: their git timeouts
  // are below the per-request hub timeout that block already waits for
  // (COMMIT_EVIDENCE_GIT_TIMEOUT_MS / LANDED_GIT_TIMEOUT_MS), so they add no
  // wall clock of their own — concurrency needs the promises started early,
  // not membership in the same Promise.all.
  const commitAuthorsPromise = collectCommitEvidence(ctx.identity.root, now);
  const defaultBranchRefPromise = resolveDefaultBranchRef(ctx.identity.root);

  // The rotation is the day number: every SessionStart on one day probes the
  // same window (idempotent replays), and the window advances daily so a
  // backlog larger than the ancestry cap is fully covered across days
  // instead of starving its tail (capture/landed.ts).
  const landedRotation = Math.floor(now.getTime() / MS_PER_DAY);

  // The Block-5 flow (connector-core/src/flows/briefing.ts): six parallel
  // GETs → drift → renderBriefing → shown solved ids. Landed detection
  // (DESIGN.md §5) rides as the flow's parallel rider — the base commits of
  // contexts the hub still lists as open, in parallel with the drift fan-out
  // so both cost one git timeout of wall clock. Fail open throughout.
  const assembled = await assembleBriefing({
    hub: ctx.hub,
    repoId: ctx.identity.repoId,
    repoRoot: ctx.identity.root,
    selfDeveloperId: developerId,
    now,
    collectLanded: async (workContexts) => {
      const defaultBranchRef = await defaultBranchRefPromise;
      // The A5-9 guard, and it lives HERE rather than inside
      // `collectLandedCommits`, which stays a pure ancestry question.
      //
      // "Landed" is supposed to mean "this branch's work reached the default
      // branch". The ancestry test alone cannot say that: a session running ON
      // the default branch — or detached at one of its ancestors, which is
      // every orchestration worktree — has a base commit that is an ancestor
      // from the moment it starts, before it has done anything at all. 118 of
      // the trial hub's 127 contexts read "landed", 79 of them within sixty
      // seconds of being created. Skipping the whole collection from such a
      // session is what makes the label mean what the surface claims; a
      // session on a real feature branch is unaffected.
      if (isOnDefaultBranch(ctx.identity.branch, defaultBranchRef)) {
        return [];
      }
      const openBaseCommits = workContexts.flatMap((entry: WorkContextEntry) =>
        entry.landedAt === null || entry.landedAt === undefined
          ? (entry.baseCommit === undefined ? [] : [entry.baseCommit])
          : [],
      );
      return defaultBranchRef === null || openBaseCommits.length === 0
        ? []
        : collectLandedCommits(
            ctx.identity.root,
            defaultBranchRef,
            openBaseCommits,
            landedRotation,
          );
    },
  });
  const { briefing, presence, landedCommits } = assembled;
  const [commitAuthors, defaultBranchRef] = await Promise.all([
    commitAuthorsPromise,
    defaultBranchRefPromise,
  ]);

  if (developerId !== null) {
    await rememberDeveloper(ctx.config, developerId, selfName(presence, developerId));
  }
  if (assembled.presenceFetched) {
    // The last-seen list rides along (Anhang A, A4-09): SessionStart already
    // holds the work contexts, so telling "offline" from "never onboarded"
    // costs one pure derivation and no hub call.
    await writePresenceCache(
      ctx.config.home,
      ctx.repoKey,
      presence,
      now,
      deriveLastSeen(assembled.workContexts, developerId),
    );
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

  // Solved-pointer telemetry (VISION.md §1 + §4 precision loop): exactly the
  // pointers the EMITTED briefing shows, through the shared flow — spool
  // append, then state, then emit (flows/briefing.ts carries the ordering
  // argument).
  await recordBriefingDeliveries({
    home: ctx.config.home,
    repoKey: ctx.repoKey,
    hostSessionKey: ctx.payload.session_id,
    crosscheckSessionId,
    producer,
    shownSolvedIds: assembled.shownSolvedIds,
    now,
  });

  // Maintenance last, on the leftover budget: the briefing above is what this
  // hook exists for, and it is already in hand when the drain starts.
  //
  // One request timeout is HELD BACK from the drain when a deferred end is
  // spendable this run. Registration appends a work-context record on every
  // start, so the drain almost always has work, and handed the whole spare it
  // runs to that deadline — the ender below then reads zero room on every
  // single start against a slow hub, and a deferred end starves to its
  // age-out instead of costing the one bounded call it needs (the livelock
  // hook-budget.test.ts pins). A marker whose own backlog is still on disk
  // holds nothing back: draining is what that marker is waiting for
  // (spool/reap.ts carries the argument).
  const endHoldbackMs = (await hasSpendablePendingEnd(
    ctx.config.home,
    ctx.repoKey,
    now,
  ))
    ? ctx.hub.timeoutMs
    : 0;
  await flushSpool(
    ctx.hub,
    { sessionId: crosscheckSessionId, developerId },
    budget.spareMs() - endHoldbackMs,
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
  // Session-state corpses, bounded (trial finding M6). Deliberately AFTER
  // reapSpool: a state file is what stops its spool being reaped
  // (spool/reap.ts isSessionLive), so removing it here means the spool goes on
  // the NEXT SessionStart rather than this one — which is right, because this
  // run has already spent its file budget. Our own state file is excluded by
  // name as well as by age.
  await reapStaleSessionStates(ctx.config.home, now, {
    keepHostSessionKey: ctx.payload.session_id,
  });

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
