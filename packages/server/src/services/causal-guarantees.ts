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
import { and, eq, inArray, sql } from "drizzle-orm";
import { CAUSAL_GUARANTEES, GUARANTEE_KINDS, foldGuaranteeDeclaration } from "@crosscheck/schema";
import type {
  CausalGuarantee,
  GuaranteeKind,
  SeqKind,
  SeqReason,
  StoredGuaranteeReason,
} from "@crosscheck/schema";

import { agentSessions, sessionCausalGuarantees } from "../db/schema.ts";
import type { DbExecutor } from "../db/client.ts";

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

const rankOf = (state: CausalGuarantee): number => CAUSAL_GUARANTEES.indexOf(state);

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
 */
export const weakenDeclaredGuarantees = async (
  db: DbExecutor,
  sessionId: string,
  raw: unknown,
): Promise<void> => {
  const sent = new Map(foldGuaranteeDeclaration(raw).map((triple) => [triple.kind, triple]));
  const stored = await db
    .select()
    .from(sessionCausalGuarantees)
    .where(eq(sessionCausalGuarantees.sessionId, sessionId));
  for (const row of stored) {
    const next = sent.get(row.kind);
    const where = and(
      eq(sessionCausalGuarantees.sessionId, sessionId),
      eq(sessionCausalGuarantees.kind, row.kind),
    );
    if (next === undefined || next.guarantee === "undeclared") {
      await db.delete(sessionCausalGuarantees).where(where);
    } else if (rankOf(next.guarantee) < rankOf(row.guarantee)) {
      await db
        .update(sessionCausalGuarantees)
        .set({ guarantee: next.guarantee, reason: next.reason })
        .where(where);
    }
  }
};

/**
 * Does this row overrule a `guaranteed` declaration of its kind? An `observed`
 * row is an upper bound the declaration said would not occur; a row with no
 * position is one the declaration said would have one. A reap is the hub's
 * own inference from silence, not a row the connector sent, so it overrules
 * nothing.
 */
export const contradictsGuaranteed = (
  seqKind: SeqKind,
  positioned: boolean,
  seqReason: SeqReason,
): boolean => seqKind === "observed" || (!positioned && seqReason !== "reaped_end");

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
