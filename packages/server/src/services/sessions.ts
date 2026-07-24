import { and, eq, isNull } from "drizzle-orm";
import type { SessionStatus } from "@crosscheck/schema";

import { EVENT_KINDS } from "../constants.ts";
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
  | { readonly outcome: "already_ended" };

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
    return { outcome: "already_ended" };
  }

  const updated = await deps.db
    .update(agentSessions)
    .set({
      agentKind: input.agentKind,
      repo: input.repo,
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