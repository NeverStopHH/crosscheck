/**
 * DECLARED CAUSAL GUARANTEES, HUB SIDE (1.0 spec 01a §3.6, §3.7).
 *
 * A session's connector says, per canonical kind, what its positions can
 * support. This module stores that statement, keeps it from ever growing, and
 * lets the session's own rows overrule it — the three things that make the
 * statement safe to show a reader beside an answer.
 *
 *   STORE   — at creation only: the folded block (schema
 *             `foldGuaranteeDeclaration`); nothing for a session that sent
 *             none, which every reader reads as `undeclared`.
 *   WEAKEN  — a re-register of the same session may lower a kind or drop it,
 *             never raise one: the rows already stored were produced under
 *             the first statement, and a stronger one now would re-describe
 *             them after the fact.
 *   CAP     — a row this session sends that is not a usable emitted position
 *             (stored `observed`, or with its position withheld) rewrites a
 *             `guaranteed` declaration for that kind to `partial /
 *             declaration_contradicted`, in place. Written, not derived on
 *             read: the cap must outlive a skeleton sweep of the row.
 *
 * Nothing here reads a guarantee into a verdict: `isJudgeable` and attribution
 * never call this module (01a §3.7, 01 §3.7 (1)).
 */
import { and, eq, gt, inArray, isNotNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
import { GUARANTEE_KINDS, ORDER_REASON_STRENGTH, foldGuaranteeDeclaration } from "@crosscheck/schema";
import type {
  CausalGuarantee,
  GuaranteeKind,
  SeqKind,
  StoredGuaranteeReason,
} from "@crosscheck/schema";

import { agentSessions, sessionCausalGuarantees, sessionEvents } from "../db/schema.ts";
import type { DbExecutor } from "../db/client.ts";
import { reasonRankSql } from "./coverage-order.ts";

export interface EffectiveGuarantee {
  readonly state: CausalGuarantee;
  readonly reason: StoredGuaranteeReason;
}

export const UNDECLARED: EffectiveGuarantee = {
  state: "undeclared",
  reason: "provider_undeclared",
};

const CONTRADICTED: EffectiveGuarantee = {
  state: "partial",
  reason: "declaration_contradicted",
};


/** At creation: the folded block, minus the triples that read undeclared anyway. */
export const storeDeclaredGuarantees = async (
  db: DbExecutor,
  sessionId: string,
  raw: unknown,
): Promise<void> => {
  const triples = foldGuaranteeDeclaration(raw).filter(
    (triple) => triple.guarantee !== "undeclared",
  );
  if (triples.length === 0) {
    return;
  }
  await db
    .insert(sessionCausalGuarantees)
    .values(triples.map((triple) => ({ sessionId, ...triple })))
    .onConflictDoNothing();
};

/**
 * A re-register: each stored kind becomes the weaker of what is stored and
 * what was sent, and a kind the new block does not declare (or a block that
 * is absent) is removed — absent reads `undeclared`, the weakest there is.
 *
 * NO READ DECIDES A WRITE (review L2). Each kind is one conditional UPDATE
 * that compares the sent reason against the STORED row's rank in SQL, so two
 * concurrent re-registers, or a cap landing beside one, can only ever leave
 * the minimum. A read-then-write let the later write of the stronger value win.
 */
export const weakenDeclaredGuarantees = async (
  db: DbExecutor,
  sessionId: string,
  raw: unknown,
): Promise<void> => {
  const sent = foldGuaranteeDeclaration(raw).filter((triple) => triple.guarantee !== "undeclared");
  const ofSession = eq(sessionCausalGuarantees.sessionId, sessionId);
  await db
    .delete(sessionCausalGuarantees)
    .where(
      sent.length === 0
        ? ofSession
        : and(ofSession, notInArray(sessionCausalGuarantees.kind, sent.map((triple) => triple.kind))),
    );
  for (const triple of sent) {
    await db
      .update(sessionCausalGuarantees)
      .set({ guarantee: triple.guarantee, reason: triple.reason })
      .where(
        and(
          ofSession,
          eq(sessionCausalGuarantees.kind, triple.kind),
          sql`${reasonRankSql(sessionCausalGuarantees.reason)} > ${ORDER_REASON_STRENGTH.indexOf(triple.reason)}`,
        ),
      );
  }
};

/**
 * Does this row overrule a `guaranteed` declaration of its kind? An `observed`
 * row is an upper bound the declaration said would not occur; a row with no
 * position is one the declaration said would have one. A reap counts too
 * (review M1): it is the hub's inference that the end was NEVER OBSERVED, and
 * a terminal position nobody observed cannot be the one `lifecycle` promised.
 */
export const contradictsGuaranteed = (seqKind: SeqKind, positioned: boolean): boolean =>
  seqKind === "observed" || !positioned;

/** The cap: a `guaranteed` declaration of this kind becomes `partial / declaration_contradicted`. */
export const capContradictedGuarantee = async (
  db: DbExecutor,
  sessionId: string,
  kind: GuaranteeKind,
): Promise<void> => {
  await db
    .update(sessionCausalGuarantees)
    .set({ guarantee: CONTRADICTED.state, reason: CONTRADICTED.reason })
    .where(
      and(
        eq(sessionCausalGuarantees.sessionId, sessionId),
        eq(sessionCausalGuarantees.kind, kind),
        eq(sessionCausalGuarantees.guarantee, "guaranteed"),
      ),
    );
};

/** The origin's position: `session.started` is minted at n = 0, never allocated. */
const ORIGIN_N = 0;

export interface SessionPosition {
  readonly epoch: string;
  readonly n: number;
}

/**
 * Does any positioned skeleton row of this session lie past `end`, or in
 * another epoch? The intent ledger's versions take positions from the same
 * counter; that half is asked by the end route (sessions.ts), because only
 * services/intent-ledger.ts may read the ledger (INT-7).
 */
const outrunsEnd = async (
  db: DbExecutor,
  sessionId: string,
  end: SessionPosition,
): Promise<boolean> => {
  const events = await db
    .select({ id: sessionEvents.id })
    .from(sessionEvents)
    .where(
      and(
        eq(sessionEvents.sessionId, sessionId),
        isNotNull(sessionEvents.seqN),
        or(ne(sessionEvents.seqEpoch, end.epoch), gt(sessionEvents.seqN, end.n)),
      ),
    )
    .limit(1);
  return events.length > 0;
};

/** Does a positioned end of this session lie below `row`, or in another epoch? */
const endBelow = async (
  db: DbExecutor,
  sessionId: string,
  row: SessionPosition,
): Promise<boolean> => {
  const ends = await db
    .select({ id: sessionEvents.id })
    .from(sessionEvents)
    .where(
      and(
        eq(sessionEvents.sessionId, sessionId),
        eq(sessionEvents.kind, "session.ended"),
        isNotNull(sessionEvents.seqN),
        or(ne(sessionEvents.seqEpoch, row.epoch), lt(sessionEvents.seqN, row.n)),
      ),
    )
    .limit(1);
  return ends.length > 0;
};

/**
 * WHAT `lifecycle` ITSELF PROMISES (review M1), checked on every positioned
 * row: the start at n = 0, and the end at the terminal position of the
 * session's one epoch. A positioned row is enough to contradict either; it
 * need not be `observed`. Both orders are checked, because the end can arrive
 * before or after the row that outruns it — end-session.ts allocates the end
 * before it deletes the state a detached worker may still allocate from.
 */
export const capLifecycleContradictions = async (
  db: DbExecutor,
  sessionId: string,
  kind: GuaranteeKind,
  position: SessionPosition,
): Promise<void> => {
  if (kind === "session.started" && position.n !== ORIGIN_N) {
    await capContradictedGuarantee(db, sessionId, "session.started");
  }
  const contradicted =
    kind === "session.ended"
      ? await outrunsEnd(db, sessionId, position)
      : await endBelow(db, sessionId, position);
  if (contradicted) {
    await capContradictedGuarantee(db, sessionId, "session.ended");
  }
};

/**
 * Each session's effective guarantee for every one of the nine kinds — its
 * stored row, capped already, or `undeclared` where there is none. A session
 * id with no rows at all is still answered, all nine `undeclared`.
 */
export const readEffectiveGuarantees = async (
  db: DbExecutor,
  sessionIds: readonly string[],
): Promise<ReadonlyMap<string, ReadonlyMap<GuaranteeKind, EffectiveGuarantee>>> => {
  const rows =
    sessionIds.length === 0
      ? []
      : await db
          .select()
          .from(sessionCausalGuarantees)
          .where(inArray(sessionCausalGuarantees.sessionId, [...sessionIds]));
  return new Map(
    sessionIds.map((sessionId) => {
      const own = new Map(
        rows
          .filter((row) => row.sessionId === sessionId)
          .map((row) => [row.kind, { state: row.guarantee, reason: row.reason }]),
      );
      return [
        sessionId,
        new Map(GUARANTEE_KINDS.map((kind) => [kind, own.get(kind) ?? UNDECLARED])),
      ];
    }),
  );
};

/**
 * How many (session, kind) declarations of THIS DEVELOPER's sessions a row
 * has overruled — doctor's count (01a §5). Scoped to the caller the way the
 * route it rides is (`GET /api/sessions/order`: "the caller's own"), so a
 * count about somebody else's sessions never reaches this person's terminal.
 */
export const countContradictedDeclarations = async (
  db: DbExecutor,
  developerId: string,
): Promise<number> => {
  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(sessionCausalGuarantees)
    .innerJoin(agentSessions, eq(agentSessions.id, sessionCausalGuarantees.sessionId))
    .where(
      and(
        eq(agentSessions.developerId, developerId),
        eq(sessionCausalGuarantees.reason, CONTRADICTED.reason),
      ),
    );
  return result[0]?.count ?? 0;
};
