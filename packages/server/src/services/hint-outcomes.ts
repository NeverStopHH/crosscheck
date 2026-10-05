/**
 * WHAT A DELIVERED HINT LED TO, recorded (1.0 spec 07 §13, 2026-10-05).
 *
 * "How often did crosscheck help me, from whom, and why — and how often did I
 * take the hint and still do it my way, because …" (Nick). Two pairs of shoes:
 * a hint deliberately set aside did its job, the reader decided with the
 * teammate's work in view; an off-target hint did not. So `overrode` is its
 * own word with its own reason, and never a kind of noise.
 *
 * THE RECIPIENT'S, NEVER A TEAMMATE'S. Only the developer the delivery
 * reached may say what it led to, and a teammate naming somebody else's
 * delivery is answered exactly like an id that does not exist — a distinct
 * refusal would tell the asker what a colleague was shown (§11.9).
 *
 * APPEND-ONLY. A repeat is answered "already recorded" and writes nothing; a
 * different word is a new row that supersedes the old by being newer. Nothing
 * is updated, nothing is deleted.
 *
 * NEVER `pilot_marks`. The agent writes these, through `mark_hint_outcome`,
 * and an agent writing a label would be the product grading itself (PIL-6).
 */
import { randomUUID } from "node:crypto";

import { and, desc, eq, ne, sql } from "drizzle-orm";
import { PULLED_DELIVERY_CHANNEL, containsSecret } from "@crosscheck/schema";
import type { HintOutcome } from "@crosscheck/schema";

import { agentSessions, hintDeliveries, hintOutcomes } from "../db/schema.ts";
import { readTeamSettings } from "./team-settings.ts";
import type { Db } from "../db/client.ts";
import type { Clock } from "../types.ts";

interface Deps {
  readonly db: Db;
  readonly now: Clock;
}

/** A delivery id as ingest derives it (`hintDeliveryId`). */
const DELIVERY_ID_PREFIX = "hd_";

/** Why an outcome was refused — an enum, so the route never invents prose. */
export type HintOutcomeRefusal =
  | "not_enrolled"
  | "unknown_ref"
  | "wrong_repo"
  | "not_unsolicited"
  | "reason_secret";

export interface WriteHintOutcomeInput {
  readonly repo: string;
  /** What the hint printed (a work-context or claim id), or a delivery id. */
  readonly ref: string;
  readonly outcome: HintOutcome;
  readonly reason: string | null;
  /** The caller's session, when it knows which one read the hint. */
  readonly session: string | null;
  readonly recordedBy: string;
}

export type WriteHintOutcomeResult =
  | {
      readonly id: string;
      readonly deliveryId: string;
      readonly outcome: HintOutcome;
      readonly repeated: boolean;
      /** The outcome this one superseded, or null when it is the first. */
      readonly replaced: HintOutcome | null;
    }
  | { readonly refusal: HintOutcomeRefusal };

interface ResolvedDelivery {
  readonly id: string;
  readonly repo: string;
  readonly recipient: string;
  readonly channel: string;
}

const deliveryColumns = {
  id: hintDeliveries.id,
  repo: agentSessions.repo,
  recipient: agentSessions.developerId,
  channel: hintDeliveries.channel,
};

/** A delivery named by its own id, whoever it reached — the refusals decide. */
const readDeliveryById = async (
  deps: Deps,
  deliveryId: string,
): Promise<ResolvedDelivery | undefined> => {
  const rows = await deps.db
    .select(deliveryColumns)
    .from(hintDeliveries)
    .innerJoin(agentSessions, eq(hintDeliveries.sessionId, agentSessions.id))
    .where(eq(hintDeliveries.id, deliveryId))
    .limit(1);
  return rows[0];
};

/**
 * THE REF A HINT PRINTED, resolved to the caller's own unasked delivery of it
 * on this repo: the named session's first, then the newest. A tripwire ask
 * and a prompt hint about the same ref are two deliveries, and the newer one
 * is the one the reader most plausibly acted on.
 */
const readDeliveryByRef = async (
  deps: Deps,
  input: WriteHintOutcomeInput,
): Promise<ResolvedDelivery | undefined> => {
  const rows = await deps.db
    .select(deliveryColumns)
    .from(hintDeliveries)
    .innerJoin(agentSessions, eq(hintDeliveries.sessionId, agentSessions.id))
    .where(
      and(
        eq(hintDeliveries.refId, input.ref),
        eq(agentSessions.repo, input.repo),
        eq(agentSessions.developerId, input.recordedBy),
        ne(hintDeliveries.channel, PULLED_DELIVERY_CHANNEL),
      ),
    )
    .orderBy(
      desc(sql`${hintDeliveries.sessionId} = ${input.session ?? ""}`),
      desc(hintDeliveries.deliveredAt),
      desc(hintDeliveries.id),
    )
    .limit(1);
  return rows[0];
};

/** In the order a person would want to be told: a mistyped id before a policy. */
const refuse = (
  delivery: ResolvedDelivery | undefined,
  input: WriteHintOutcomeInput,
): HintOutcomeRefusal | null => {
  if (delivery === undefined || delivery.recipient !== input.recordedBy) {
    return "unknown_ref";
  }
  if (delivery.repo !== input.repo) {
    return "wrong_repo";
  }
  if (delivery.channel === PULLED_DELIVERY_CHANNEL) {
    return "not_unsolicited";
  }
  return null;
};

const readCurrent = async (
  deps: Deps,
  deliveryId: string,
  recordedBy: string,
): Promise<{ readonly outcome: HintOutcome; readonly reason: string | null } | undefined> => {
  const rows = await deps.db
    .select({ outcome: hintOutcomes.outcome, reason: hintOutcomes.reason })
    .from(hintOutcomes)
    .where(and(eq(hintOutcomes.deliveryId, deliveryId), eq(hintOutcomes.recordedBy, recordedBy)))
    .orderBy(desc(hintOutcomes.createdAt), desc(hintOutcomes.id))
    .limit(1);
  return rows[0];
};

export const writeHintOutcome = async (
  deps: Deps,
  input: WriteHintOutcomeInput,
): Promise<WriteHintOutcomeResult> => {
  const settings = await readTeamSettings(deps, input.repo);
  if (!settings.pilotEnrolled) {
    return { refusal: "not_enrolled" };
  }
  // ONE HELPER, EVERY WRITER: a body posted straight at the route bypasses
  // the connector's own scan. A hit drops the whole outcome — a stored
  // derivative of a secret still leaks its shape.
  if (input.reason !== null && containsSecret(input.reason)) {
    return { refusal: "reason_secret" };
  }
  const delivery = input.ref.startsWith(DELIVERY_ID_PREFIX)
    ? await readDeliveryById(deps, input.ref)
    : await readDeliveryByRef(deps, input);
  const refusal = refuse(delivery, input);
  if (refusal !== null || delivery === undefined) {
    return { refusal: refusal ?? "unknown_ref" };
  }
  const current = await readCurrent(deps, delivery.id, input.recordedBy);
  if (current !== undefined && current.outcome === input.outcome && current.reason === input.reason) {
    return { id: delivery.id, deliveryId: delivery.id, outcome: input.outcome, repeated: true, replaced: null };
  }
  const id = `ho_${randomUUID()}`;
  await deps.db.insert(hintOutcomes).values({
    id,
    repo: input.repo,
    deliveryId: delivery.id,
    outcome: input.outcome,
    reason: input.reason,
    recordedBy: input.recordedBy,
    createdAt: deps.now(),
  });
  return {
    id,
    deliveryId: delivery.id,
    outcome: input.outcome,
    repeated: false,
    replaced: current?.outcome ?? null,
  };
};
