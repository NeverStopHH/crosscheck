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

import { and, desc, eq, ne, sql } from "drizzle-orm";
import { PULLED_DELIVERY_CHANNEL, containsSecret } from "@crosscheck/schema";
import type { HintOutcome } from "@crosscheck/schema";

import { PILOT_RETENTION_DAYS } from "../constants.ts";
import { agentSessions, hintDeliveries, hintOutcomes } from "../db/schema.ts";
import { NOISE_WORDS } from "./pilot-label-figures.ts";
import { readTeamSettings } from "./team-settings.ts";
import type { Db } from "../db/client.ts";
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

/** What a delivery can stand at once something was said: an outcome, or the person's noise label. */
type StandingWord = HintOutcome | "noise";

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
  readonly repo: string;
  readonly recipient: string;
  readonly channel: string;
  readonly deliveredAt: Date;
}

const deliveryColumns = {
  id: hintDeliveries.id,
  repo: agentSessions.repo,
  recipient: agentSessions.developerId,
  channel: hintDeliveries.channel,
  deliveredAt: hintDeliveries.deliveredAt,
};

/** What bounds a countable delivery: the repo's recordable instant, and the widest window's start. */
interface CountableSince {
  readonly outcomesSince: Date | null;
  readonly windowStart: Date;
}

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
  if (countable.outcomesSince === null || delivery.deliveredAt.getTime() < countable.outcomesSince.getTime()) {
    return "before_outcomes";
  }
  return delivery.deliveredAt.getTime() < countable.windowStart.getTime() ? "past_window" : null;
};

const countableSince = (outcomesSinceIso: string | null, now: Date): CountableSince => ({
  outcomesSince: outcomesSinceIso === null ? null : new Date(outcomesSinceIso),
  windowStart: new Date(now.getTime() - PILOT_RETENTION_DAYS * MS_PER_DAY),
});

interface Standing {
  readonly word: StandingWord;
  readonly reason: string | null;
}

const readLatestOutcome = async (
  deps: Deps,
  deliveryId: string,
  recordedBy: string,
): Promise<{ readonly outcome: HintOutcome; readonly reason: string | null; readonly createdAt: Date } | undefined> => {
  const rows = await deps.db
    .select({ outcome: hintOutcomes.outcome, reason: hintOutcomes.reason, createdAt: hintOutcomes.createdAt })
    .from(hintOutcomes)
    .where(and(eq(hintOutcomes.deliveryId, deliveryId), eq(hintOutcomes.recordedBy, recordedBy)))
    .orderBy(desc(hintOutcomes.createdAt), desc(hintOutcomes.id))
    .limit(1);
  return rows[0];
};

/** When the recipient labelled this delivery noise, newest — the one noise concept (07 §13.2). */
const readNoiseLabelAt = async (deps: Deps, deliveryId: string, recipient: string): Promise<Date | null> => {
  const rows = await deps.db.execute<{ at: string | Date | null }>(sql`
    SELECT max(m.created_at) AS at FROM pilot_marks m
    WHERE m.ref_kind = 'hint_delivery' AND m.ref_id = ${deliveryId}
      AND m.marked_by = ${recipient} AND m.mark IN ${NOISE_WORDS}`);
  const at = rows.rows[0]?.at ?? null;
  return at === null ? null : new Date(at);
};

/** What stands before this word, by the view's rule: the later of the two, the label on a tie. */
const readStanding = async (
  deps: Deps,
  deliveryId: string,
  recipient: string,
): Promise<{ readonly standing: Standing | null; readonly noiseAt: Date | null }> => {
  const [latest, noiseAt] = await Promise.all([
    readLatestOutcome(deps, deliveryId, recipient),
    readNoiseLabelAt(deps, deliveryId, recipient),
  ]);
  const isNoise = noiseAt !== null && (latest === undefined || noiseAt.getTime() >= latest.createdAt.getTime());
  if (isNoise) {
    return { standing: { word: "noise", reason: null }, noiseAt };
  }
  return { standing: latest === undefined ? null : { word: latest.outcome, reason: latest.reason }, noiseAt };
};

/** One new row — never an update: a changed word supersedes the old by being newer. */
const appendOutcome = async (
  deps: Deps,
  deliveryId: string,
  input: WriteHintOutcomeInput,
): Promise<{ readonly id: string; readonly now: Date }> => {
  const id = `ho_${randomUUID()}`;
  const now = deps.now();
  await deps.db.insert(hintOutcomes).values({
    id,
    repo: input.repo,
    deliveryId,
    outcome: input.outcome,
    reason: input.reason,
    recordedBy: input.recordedBy,
    createdAt: now,
  });
  return { id, now };
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
  const refusal = refuse(delivery, input, countableSince(settings.pilotOutcomesSince, deps.now()));
  if (refusal !== null || delivery === undefined) {
    return { refusal: refusal ?? "unknown_ref" };
  }
  const { standing, noiseAt } = await readStanding(deps, delivery.id, input.recordedBy);
  if (standing !== null && standing.word === input.outcome && standing.reason === input.reason) {
    return {
      id: delivery.id,
      deliveryId: delivery.id,
      outcome: input.outcome,
      repeated: true,
      replaced: null,
      stands: input.outcome,
    };
  }
  const { id, now } = await appendOutcome(deps, delivery.id, input);
  return {
    id,
    deliveryId: delivery.id,
    outcome: input.outcome,
    repeated: false,
    replaced: standing?.word ?? null,
    stands: noiseAt !== null && noiseAt.getTime() >= now.getTime() ? "noise" : input.outcome,
  };
};
