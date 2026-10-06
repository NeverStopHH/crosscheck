/**
 * The hint-outcome hub calls (1.0 spec 07 §13): record what a delivered hint
 * led to, and read the caller's own outcomes back.
 *
 * A FILE OF ITS OWN, beside `http/pilot.ts` and not inside it: that file's
 * header pins the complete list of callers that may write a pilot LABEL, and
 * the first caller here is an MCP tool. Keeping the agent's write path in a
 * module the label pin never names is what lets both pins stay true.
 *
 * THE VIEW'S PARSE IS STRICT, for `http/pilot.ts`'s reason: "followed 0" is a
 * claim, and a count that did not arrive must not read as one. Only the
 * outcome WORDS are open strings — a newer hub's word is printed as itself.
 */
import { z } from "zod";
import type { HintOutcome } from "@crosscheck/schema";

import { hubRequest } from "./client.ts";
import { UNREADABLE_BLOCK } from "./pilot.ts";
import type { UnreadableBlock } from "./pilot.ts";
import type { HubContext, HubResult } from "./client.ts";

const CountSchema = z.number().int().min(0);

/** What an older hub answers a route it does not have — "this hub does not record outcomes". */
export const HINT_OUTCOMES_NOT_SERVED_STATUS = 404;

/**
 * A 404 on these routes, however it was spelled: the hub's own `not_found`
 * envelope, or a proxy's page in front of an older hub. A hub that HAS the
 * routes answers every refusal with 422, so a 404 here can only mean absent.
 */
export const isOutcomesNotServed = (result: HubResult<unknown>): boolean =>
  !result.ok && result.kind !== "network" && result.status === HINT_OUTCOMES_NOT_SERVED_STATUS;

const RecordedOutcomeSchema = z.looseObject({
  id: z.string().min(1),
  deliveryId: z.string().min(1),
  outcome: z.string().min(1),
  /** The caller had said exactly this already; nothing was written. */
  repeated: z.boolean(),
  /** What this one superseded — an outcome or the person's noise label, kept, never deleted — or null. */
  replaced: z.string().nullable(),
  /**
   * What the delivery stands at now (review #11): the word just said, or a
   * noise label from the same instant. Absent from an older hub, which is
   * read as the word itself.
   */
  stands: z.string().min(1).optional(),
});

export type RecordedOutcome = z.infer<typeof RecordedOutcomeSchema>;

export interface HintOutcomeRequest {
  readonly repo: string;
  /** What the hint printed — a work-context or claim id — or a delivery id. */
  readonly ref: string;
  readonly outcome: HintOutcome;
  readonly reason?: string;
  /** The session that read the hint, when the caller knows it unambiguously. */
  readonly session?: string;
}

export const postHintOutcome = (
  ctx: HubContext,
  request: HintOutcomeRequest,
): Promise<HubResult<RecordedOutcome>> =>
  hubRequest(ctx, {
    method: "POST",
    path: "/api/hint-outcomes",
    schema: RecordedOutcomeSchema,
    body: {
      repo: request.repo,
      ref: request.ref,
      outcome: request.outcome,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      ...(request.session === undefined ? {} : { session: request.session }),
    },
  });

const TallyShape = {
  received: CountSchema,
  followed: CountSchema,
  overrode: CountSchema,
  notRelevantNow: CountSchema,
  noise: CountSchema,
  unmarked: CountSchema,
};

const SourceTallySchema = z.looseObject({
  /** The teammate's display name — their own text — or null when unknown. */
  source: z.string().nullable(),
  ...TallyShape,
});

export type SourceTally = z.infer<typeof SourceTallySchema>;

const OutcomeReasonSchema = z.looseObject({
  outcome: z.string().min(1),
  reason: z.string(),
  source: z.string().nullable(),
});

export type OutcomeReason = z.infer<typeof OutcomeReasonSchema>;

/**
 * The source credit (review #10): one closed month's follows of the caller's
 * work, or the reason there is no number — never both. Strict inside, strict
 * about itself only: a credit this client cannot read is said to be
 * unreadable, and the rest of the person's view is still read.
 */
const CreditSchema = z
  .looseObject({
    periodStartIso: z.string().min(1),
    periodEndIso: z.string().min(1),
    followed: CountSchema.nullable(),
    withheld: z.string().min(1).nullable(),
  })
  .refine((credit) => (credit.withheld === null) === (credit.followed !== null), {
    message: "a source credit is either withheld or counted",
  });

export type Credit = z.infer<typeof CreditSchema>;

const readCredit = (raw: unknown): Credit | UnreadableBlock => {
  const parsed = CreditSchema.safeParse(raw);
  return parsed.success ? parsed.data : UNREADABLE_BLOCK;
};

export const MyHintOutcomesSchema = z.looseObject({
  repo: z.string().min(1),
  days: z.number().int().min(1),
  sinceIso: z.string().min(1),
  untilIso: z.string().min(1),
  /** 07 §13.11 (review M3): the pilot paused inside the window. Absent from an older hub, which never paused. */
  pausedInWindow: z.boolean().optional(),
  ...TallyShape,
  bySource: z.array(SourceTallySchema),
  bySourceBeyondList: CountSchema,
  reasons: z.array(OutcomeReasonSchema),
  reasonsBeyondList: CountSchema,
  /** 07 §13.11 (round 3): lenient as a block — an unreadable credit never rejects the person's own view. */
  yourWork: z.unknown().transform(readCredit),
});

export type MyHintOutcomes = z.infer<typeof MyHintOutcomesSchema>;

export interface MyHintOutcomesRequest {
  readonly repo: string;
  /** Omitted: the hub's own default window. */
  readonly days?: number;
}

export const getMyHintOutcomes = (
  ctx: HubContext,
  request: MyHintOutcomesRequest,
): Promise<HubResult<MyHintOutcomes>> => {
  const days = request.days === undefined ? "" : `&days=${String(request.days)}`;
  return hubRequest(ctx, {
    method: "GET",
    path: `/api/hint-outcomes/mine?repo=${encodeURIComponent(request.repo)}${days}`,
    schema: MyHintOutcomesSchema,
  });
};
