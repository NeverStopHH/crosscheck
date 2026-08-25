import { and, desc, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import type { SessionStatus } from "@crosscheck/schema";

import {
  EVENT_KINDS,
  OPEN_SESSIONS_MAX,
  SESSION_REAP_MAX_PER_PASS,
  SESSION_REAP_STALE_HOURS,
} from "../constants.ts";
import { agentSessions } from "../db/schema.ts";
import { appendEvent } from "./events.ts";
import type { Db } from "../db/client.ts";
import type { Clock } from "../types.ts";
import type { RegisterSessionBody } from "../http/schemas.ts";

const DEFAULT_END_STATUS: SessionStatus = "done";

interface Deps {
  readonly db: Db;
  readonly now: Clock;
}

type SessionRow = typeof agentSessions.$inferSelect;

export interface SessionView {
  readonly id: string;
  readonly developerId: string;
  readonly agentKind: string;
  readonly repo: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly status: string;
  readonly startedAt: string;
  readonly lastHeartbeatAt: string;
  readonly endedAt: string | null;
}

const toSessionView = (row: SessionRow): SessionView => ({
  id: row.id,
  developerId: row.developerId,
  agentKind: row.agentKind,
  repo: row.repo,
  branch: row.branch,
  baseCommit: row.baseCommit,
  status: row.status,
  startedAt: row.startedAt.toISOString(),
  lastHeartbeatAt: row.lastHeartbeatAt.toISOString(),
  endedAt: row.endedAt === null ? null : row.endedAt.toISOString(),
});

const findSessionById = async (
  db: Db,
  id: string,
): Promise<SessionRow | undefined> => {
  const rows = await db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, id))
    .limit(1);
  return rows[0];
};

const requireWrittenRow = (rows: SessionRow[]): SessionRow => {
  const row = rows[0];
  if (row === undefined) {
    throw new Error("session write returned no row");
  }
  return row;
};

export type RegisterSessionResult =
  | { readonly outcome: "created" | "updated"; readonly session: SessionView }
  | { readonly outcome: "foreign_session" }
  | { readonly outcome: "already_ended" }
  | { readonly outcome: "repo_mismatch" };

export const registerSession = async (
  deps: Deps,
  developerId: string,
  input: RegisterSessionBody,
): Promise<RegisterSessionResult> => {
  const timestamp = deps.now();
  const inserted = await deps.db
    .insert(agentSessions)
    .values({
      id: input.id,
      developerId,
      agentKind: input.agentKind,
      repo: input.repo,
      branch: input.branch,
      baseCommit: input.baseCommit,
      status: input.status,
      startedAt: timestamp,
      lastHeartbeatAt: timestamp,
    })
    .onConflictDoNothing()
    .returning();
  const insertedRow = inserted[0];
  if (insertedRow !== undefined) {
    await appendEvent(deps, EVENT_KINDS.SESSION_STARTED, {
      sessionId: insertedRow.id,
      developerId,
      repo: insertedRow.repo,
      branch: insertedRow.branch,
    });
    return { outcome: "created", session: toSessionView(insertedRow) };
  }

  const existing = await findSessionById(deps.db, input.id);
  if (existing === undefined) {
    throw new Error("session insert conflicted but row was not found");
  }
  if (existing.developerId !== developerId) {
    return { outcome: "foreign_session" };
  }
  if (existing.endedAt !== null) {
    if (existing.reapedAt === null) {
      return { outcome: "already_ended" };
    }
    // The session the hub gave up on is registering again, which is proof it
    // was alive. Reviving beats 409: a `already_ended` here would leave the
    // connector holding a session id the hub refuses every record from, for
    // the whole life of that session (review finding B2-01).
    await reviveReapedSession(deps, existing);
  }
  // One crosscheck session is ONE repo, bound at registration (trial finding
  // #9, first-wins). A live session re-registering under a DIFFERENT repo is
  // the state-less recovery race or a mid-session identity change — both are
  // refused rather than silently re-homed: past work stays attributed to the
  // repo that produced it, and the connector's own foreign-repo guard drops
  // the touch (the state-file path already did; this closes the no-state
  // path). Branch and base commit may still move — checkouts are normal.
  if (existing.repo !== input.repo) {
    return { outcome: "repo_mismatch" };
  }

  const updated = await deps.db
    .update(agentSessions)
    .set({
      agentKind: input.agentKind,
      status: input.status,
      branch: input.branch,
      baseCommit: input.baseCommit,
      lastHeartbeatAt: timestamp,
    })
    .where(eq(agentSessions.id, input.id))
    .returning();
  return {
    outcome: "updated",
    session: toSessionView(requireWrittenRow(updated)),
  };
};

export type HeartbeatResult =
  | { readonly outcome: "ok"; readonly session: SessionView }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "forbidden" }
  | { readonly outcome: "already_ended" };

export const heartbeatSession = async (
  deps: Deps,
  developerId: string,
  sessionId: string,
  status?: SessionStatus,
): Promise<HeartbeatResult> => {
  const existing = await findSessionById(deps.db, sessionId);
  if (existing === undefined) {
    return { outcome: "not_found" };
  }
  if (existing.developerId !== developerId) {
    return { outcome: "forbidden" };
  }
  if (existing.endedAt !== null) {
    return { outcome: "already_ended" };
  }

  const updated = await deps.db
    .update(agentSessions)
    .set({
      lastHeartbeatAt: deps.now(),
      ...(status === undefined ? {} : { status }),
    })
    .where(eq(agentSessions.id, sessionId))
    .returning();
  return { outcome: "ok", session: toSessionView(requireWrittenRow(updated)) };
};

export type EndSessionResult =
  | { readonly outcome: "ended"; readonly session: SessionView }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "forbidden" };

export const endSession = async (
  deps: Deps,
  developerId: string,
  sessionId: string,
  status?: SessionStatus,
): Promise<EndSessionResult> => {
  const existing = await findSessionById(deps.db, sessionId);
  if (existing === undefined) {
    return { outcome: "not_found" };
  }
  if (existing.developerId !== developerId) {
    return { outcome: "forbidden" };
  }

  const finalStatus = status ?? DEFAULT_END_STATUS;
  const updated = await deps.db
    .update(agentSessions)
    .set({ endedAt: deps.now(), status: finalStatus })
    .where(and(eq(agentSessions.id, sessionId), isNull(agentSessions.endedAt)))
    .returning();
  const row = updated[0];
  if (row === undefined) {
    // Idempotent: ending twice reports the already-ended session.
    const alreadyEnded = await findSessionById(deps.db, sessionId);
    if (alreadyEnded === undefined) {
      return { outcome: "not_found" };
    }
    return { outcome: "ended", session: toSessionView(alreadyEnded) };
  }
  await appendEvent(deps, EVENT_KINDS.SESSION_ENDED, {
    sessionId: row.id,
    developerId,
    repo: row.repo,
    status: finalStatus,
  });
  return { outcome: "ended", session: toSessionView(row) };
};

const MS_PER_HOUR = 60 * 60 * 1000;

export interface ReapStaleSessionsOptions {
  readonly staleHours?: number;
  readonly limit?: number;
  /** Confine the pass to one developer's own sessions (the SessionStart path). */
  readonly developerId?: string;
}

export interface ReapResult {
  readonly ended: readonly SessionView[];
}

/**
 * Closes sessions that stopped heartbeating (trial finding M6).
 *
 * 104 of the trial hub's 127 sessions never ended, because `endSession` above
 * was the only writer of `ended_at` and nothing ran on a timer. A killed
 * orchestration agent, a closed terminal, a SessionEnd that ran out of budget
 * — each one left a row that every listing, every presence query and every
 * `/api/events` reader treated as live work.
 *
 * IT WRITES, rather than filtering at read time, and that is the deliberate
 * half. A listing-only reaper would leave `/api/events` — the surface the
 * trial audit itself trusted — stating 127 starts and 23 ends forever. So the
 * `ended_at` lands and ONE `session_ended` event is appended per row, through
 * the same `appendEvent` the ordinary end uses, and the ledger stays true.
 *
 * THE PREDICATE IS BOUNDED but it is not sufficient on its own: `ended_at IS
 * NULL AND last_heartbeat_at < cutoff`, a per-pass `limit`, and a cutoff 240x
 * the presence TTL. A session heartbeating every twenty seconds can never
 * match — and a session that only READS for six hours matches easily, because
 * the connector heartbeats from Edit and Bash alone (ledger M7). Ending a live
 * session used to make ingest reject its records with `accepted:0` while the
 * spool cursor advanced past them, which is exactly the deafness this batch
 * exists to remove (review finding B2-01).
 *
 * SO THE SAFETY IS DOWNSTREAM, in services/records.ts: a flush refreshes
 * `last_heartbeat_at` (a session that captures is never a candidate), and a
 * record from a session this function closed REOPENS it rather than being
 * discarded — which is what `reaped_at` is written for below.
 * `test/session-reaper.test.ts` pins the never-reap case and
 * `test/session-reap-liveness.test.ts` pins both halves of the revocation.
 */
export const reapStaleSessions = async (
  deps: Deps,
  options: ReapStaleSessionsOptions = {},
): Promise<ReapResult> => {
  const now = deps.now();
  const cutoff = new Date(
    now.getTime() - (options.staleHours ?? SESSION_REAP_STALE_HOURS) * MS_PER_HOUR,
  );
  const limit = Math.min(
    options.limit ?? SESSION_REAP_MAX_PER_PASS,
    SESSION_REAP_MAX_PER_PASS,
  );
  // Candidates first, then one UPDATE by id: a bare `UPDATE … LIMIT` is not
  // portable, and the two-step keeps the write bounded by construction.
  const candidates = await deps.db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        isNull(agentSessions.endedAt),
        lt(agentSessions.lastHeartbeatAt, cutoff),
        ...(options.developerId === undefined
          ? []
          : [eq(agentSessions.developerId, options.developerId)]),
      ),
    )
    .limit(limit);
  if (candidates.length === 0) {
    return { ended: [] };
  }
  const updated = await deps.db
    .update(agentSessions)
    // `reapedAt` beside `endedAt` is what makes this verdict revocable: an
    // end the hub INFERRED from silence, which a record from that session can
    // disprove — services/records.ts checkProducerSession calls
    // `reviveReapedSession` below when one arrives. A connector's own
    // SessionEnd leaves `reapedAt` null and stays final.
    .set({ endedAt: now, status: DEFAULT_END_STATUS, reapedAt: now })
    .where(
      and(
        inArray(
          agentSessions.id,
          candidates.map((row) => row.id),
        ),
        // Re-checked inside the write: a session that heartbeated between the
        // SELECT and the UPDATE must survive, and two concurrent passes must
        // not both claim the same row.
        isNull(agentSessions.endedAt),
      ),
    )
    .returning();
  for (const row of updated) {
    await appendEvent(deps, EVENT_KINDS.SESSION_ENDED, {
      sessionId: row.id,
      developerId: row.developerId,
      repo: row.repo,
      status: DEFAULT_END_STATUS,
      // The one field that tells a reader this end was the hub's doing and
      // not the connector's — `/api/events` is a ledger, so the difference
      // belongs in it.
      reapedAfterHours: options.staleHours ?? SESSION_REAP_STALE_HOURS,
    });
  }
  return { ended: updated.map(toSessionView) };
};

/**
 * Undoes a reap that the world has since disproved (review finding B2-01).
 *
 * `reapStaleSessions` closes a session on ONE signal: no heartbeat for
 * SESSION_REAP_STALE_HOURS. That signal is weaker than it reads, because the
 * connector only heartbeats from PostToolUse on an Edit or a Bash (ledger M7),
 * so a session that spent the afternoon reading and planning looks exactly
 * like a killed terminal. When such a session then speaks — a record, or a
 * SessionStart re-fire — the silence has been refuted, and the row has to
 * reopen rather than spend the rest of its life having its records rejected
 * with `accepted:0`.
 *
 * ONLY a reaped end is reversible. `endedAt` set with `reapedAt` null is a
 * SessionEnd the session itself reported, and late writes against it stay
 * rejected — that gate is what keeps a dead session's spool from being
 * replayed in its own name (spool/flush.ts stamps the FLUSHING session).
 *
 * The reopening is appended to `/api/events` as a `session_started` carrying
 * `revivedAfterReap`, because that stream is a ledger: a `session_ended` with
 * no counterpart would leave every reader of it — the trial audit included —
 * believing the session stopped there.
 */
export const reviveReapedSession = async (
  deps: Deps,
  row: SessionRow,
): Promise<void> => {
  const revived = await deps.db
    .update(agentSessions)
    .set({ endedAt: null, reapedAt: null, lastHeartbeatAt: deps.now() })
    // Re-checked inside the write: only a row that is STILL a reaped corpse
    // may be reopened, so a real SessionEnd landing between the read and this
    // write is never undone.
    .where(
      and(
        eq(agentSessions.id, row.id),
        isNotNull(agentSessions.reapedAt),
        isNotNull(agentSessions.endedAt),
      ),
    )
    .returning();
  if (revived.length === 0) {
    return;
  }
  await appendEvent(deps, EVENT_KINDS.SESSION_STARTED, {
    sessionId: row.id,
    developerId: row.developerId,
    repo: row.repo,
    branch: row.branch,
    revivedAfterReap: true,
  });
};

export interface ListOpenSessionsOptions {
  /** Only the caller's own sessions. */
  readonly mine?: boolean;
  readonly limit?: number;
  /** Silence required before a row counts; defaults to the reaper's window. */
  readonly staleHours?: number;
}

/**
 * Sessions the hub still believes are running AND that stopped reporting
 * (trial finding M6, corrected by review finding B2-03).
 *
 * `doctor`'s `unclosed sessions` line counted only local `.pending-end`
 * markers that had aged out, so it read "none" on a machine with 100 zombie
 * state files and a hub holding 104 never-ended sessions. This is the number
 * that makes that line true, and it is the hub's answer rather than a guess
 * assembled from local files.
 *
 * THE STALENESS HALF IS NOT OPTIONAL. A first version answered every row with
 * `ended_at IS NULL`, which includes the session the caller is running right
 * now — so the line WARNed from a developer's first session onward and its
 * PASS state was unreachable while anybody worked, on a check whose exit code
 * scripts gate on. `open` therefore means "open and silent past the reaper's
 * own window": the same threshold `reapStaleSessions` uses, so the count and
 * the reap can never disagree, and a number above zero always names rows a
 * reaper pass has not reached yet (an older hub, a bounded pass, a hub not
 * restarted since the reaper shipped).
 */
export const listOpenSessions = async (
  deps: Deps,
  developerId: string,
  options: ListOpenSessionsOptions = {},
): Promise<readonly SessionView[]> => {
  const cutoff = new Date(
    deps.now().getTime() -
      (options.staleHours ?? SESSION_REAP_STALE_HOURS) * MS_PER_HOUR,
  );
  const rows = await deps.db
    .select()
    .from(agentSessions)
    .where(
      and(
        isNull(agentSessions.endedAt),
        lt(agentSessions.lastHeartbeatAt, cutoff),
        ...(options.mine === true
          ? [eq(agentSessions.developerId, developerId)]
          : []),
      ),
    )
    .orderBy(desc(agentSessions.lastHeartbeatAt))
    .limit(Math.min(options.limit ?? OPEN_SESSIONS_MAX, OPEN_SESSIONS_MAX));
  return rows.map(toSessionView);
};
