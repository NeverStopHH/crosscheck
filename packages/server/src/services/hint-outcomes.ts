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
 * A REPEAT IS JUDGED AGAINST WHAT STANDS (review #11), and that may be the
 * person's later noise label rather than the newest outcome row: the same word
 * said again after the label is a new word, written, superseding the label.
 * The answer always carries what stands once it is said — the label on a tie
 * (D-O7) — so no reply claims a word stands that does not.
 *
 * NEVER A WORD NO FIGURE COUNTS (review #12). A delivery from before outcomes
 * became recordable on the repo is outside every outcome figure (the floor,
 * §13.9), and one older than the widest window is outside all of them too;
 * recording either would answer "recorded" for a word nothing will ever show.
 * Both are refused, each with why.
 *
 * NEVER `pilot_marks`. The agent writes these, through `mark_hint_outcome`,
 * and an agent writing a label would be the product grading itself (PIL-6).
 */
import { randomUUID } from "node:crypto";

import { and, desc, eq, sql } from "drizzle-orm";
import { PULLED_DELIVERY_CHANNEL, containsSecret } from "@crosscheck/schema";
import type { HintOutcome } from "@crosscheck/schema";

import { PILOT_RETENTION_DAYS } from "../constants.ts";
import { agentSessions, hintDeliveries, hintOutcomes } from "../db/schema.ts";
import { readEnrolments } from "./outcome-population.ts";
import type { Enrolment } from "./outcome-population.ts";
import {
  instantAfter,
  lockPointer,
  readPointerNoise,
  readPointerOutcome,
  standingOf,
} from "./pointer-standing.ts";
import type { StandingWord } from "./pointer-standing.ts";
import { readTeamSettings } from "./team-settings.ts";
import type { Db, DbExecutor } from "../db/client.ts";
import type { Clock } from "../types.ts";

interface Deps {
  readonly db: Db;
  readonly now: Clock;
}

/** A delivery id as ingest derives it (`hintDeliveryId`). */
const DELIVERY_ID_PREFIX = "hd_";
const MS_PER_DAY = 86_400_000;

/** Why an outcome was refused — an enum, so the route never invents prose. */
export type HintOutcomeRefusal =
  | "not_enrolled"
  | "unknown_ref"
  | "wrong_repo"
  | "not_unsolicited"
  | "before_outcomes"
  | "while_paused"
  | "past_window"
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
      /** What this one superseded — an outcome or the noise label — or null when nothing stood. */
      readonly replaced: StandingWord | null;
      /** What the delivery stands at now: the word just said, or a noise label from the same instant. */
      readonly stands: StandingWord;
    }
  | { readonly refusal: HintOutcomeRefusal };

interface ResolvedDelivery {
  readonly id: string;
  readonly sessionId: string;
  readonly refId: string;
  readonly repo: string;
  readonly recipient: string;
  readonly channel: string;
  readonly deliveredAt: Date;
}

const deliveryColumns = {
  id: hintDeliveries.id,
  sessionId: hintDeliveries.sessionId,
  refId: hintDeliveries.refId,
  repo: agentSessions.repo,
  recipient: agentSessions.developerId,
  channel: hintDeliveries.channel,
  deliveredAt: hintDeliveries.deliveredAt,
};

/** What bounds a countable delivery: the repo's enrolled intervals, and the widest window's start. */
interface CountableSince {
  readonly enrolments: readonly Enrolment[];
  readonly windowStart: Date;
}

const isInside = (instant: Date, enrolment: Enrolment): boolean =>
  instant.getTime() >= enrolment.start.getTime() &&
  (enrolment.end === null || instant.getTime() < enrolment.end.getTime());

/**
 * WHY A DELIVERY'S OUTCOME COULD NEVER BE COUNTED, or null when it could
 * (review #12, M3): it reached the reader before the repo was first in the
 * pilot, or while the pilot was paused — or before the widest window.
 */
const uncountable = (deliveredAt: Date, countable: CountableSince): HintOutcomeRefusal | null => {
  if (!countable.enrolments.some((enrolment) => isInside(deliveredAt, enrolment))) {
    const [first] = countable.enrolments;
    return first === undefined || deliveredAt.getTime() < first.start.getTime() ? "before_outcomes" : "while_paused";
  }
  return deliveredAt.getTime() < countable.windowStart.getTime() ? "past_window" : null;
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
 * THE REF A HINT PRINTED, resolved to the caller's own delivery of it on this
 * repo: an unasked one first, then the named session's, then the newest. A
 * tripwire ask and a prompt hint about the same ref are two deliveries, and the
 * newer one is the one the reader most plausibly acted on. A ref that only
 * ever arrived because the reader ASKED resolves to that pulled delivery, so
 * the refusal says it was asked for — not that nothing reached them (review).
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
      ),
    )
    .orderBy(
      desc(sql`${hintDeliveries.channel} <> ${PULLED_DELIVERY_CHANNEL}`),
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
  countable: CountableSince,
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
  return uncountable(delivery.deliveredAt, countable);
};

const countableSince = async (deps: Deps, repo: string): Promise<CountableSince> => ({
  enrolments: await readEnrolments(deps.db, repo),
  windowStart: new Date(deps.now().getTime() - PILOT_RETENTION_DAYS * MS_PER_DAY),
});

type Recorded = Exclude<WriteHintOutcomeResult, { readonly refusal: HintOutcomeRefusal }>;

/**
 * THE WORD, DECIDED AND WRITTEN UNDER THE POINTER'S LOCK (review H2). A
 * repeat is judged against the recipient's own newest word — so the word a
 * person's noise label superseded, said again by an agent re-reading the
 * clause, writes nothing and answers that the label stands; only a NEW word
 * supersedes the label. A new word is stamped strictly after the pointer's
 * newest one, so the order of two words never depends on a millisecond.
 */
const recordOnPointer = (deps: Deps, delivery: ResolvedDelivery, input: WriteHintOutcomeInput): Promise<Recorded> =>
  deps.db.transaction(async (tx) => {
    const pointer = { sessionId: delivery.sessionId, refId: delivery.refId };
    await lockPointer(tx, pointer);
    const latest = await readPointerOutcome(tx, pointer, input.recordedBy);
    const noise = await readPointerNoise(tx, pointer, input.recordedBy);
    const before = standingOf(latest, noise);
    const answer = { deliveryId: delivery.id, outcome: input.outcome };
    if (latest !== undefined && latest.outcome === input.outcome && latest.reason === input.reason) {
      return { ...answer, id: delivery.id, repeated: true, replaced: null, stands: before ?? input.outcome };
    }
    const createdAt = instantAfter(deps.now(), latest?.createdAt);
    const id = await appendOutcome(tx, delivery.id, input, createdAt);
    const now = { outcome: input.outcome, reason: input.reason, createdAt };
    return { ...answer, id, repeated: false, replaced: before, stands: standingOf(now, noise) ?? input.outcome };
  });

/** One new row — never an update: a changed word supersedes the old by being newer. */
const appendOutcome = async (
  tx: DbExecutor,
  deliveryId: string,
  input: WriteHintOutcomeInput,
  createdAt: Date,
): Promise<string> => {
  const id = `ho_${randomUUID()}`;
  await tx.insert(hintOutcomes).values({
    id,
    repo: input.repo,
    deliveryId,
    outcome: input.outcome,
    reason: input.reason,
    recordedBy: input.recordedBy,
    createdAt,
  });
  return id;
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
  const refusal = refuse(delivery, input, await countableSince(deps, input.repo));
  if (refusal !== null || delivery === undefined) {
    return { refusal: refusal ?? "unknown_ref" };
  }
  return recordOnPointer(deps, delivery, input);
};
