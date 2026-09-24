/**
 * The pilot's hub calls (1.0 spec 07 §5) — the one read behind
 * `crosscheck pilot`.
 *
 * A FILE OF ITS OWN rather than more of `http/hub.ts`, which is past two and a
 * half thousand lines; the pilot is one feature with one reader, and the
 * reason for its parse rule below is different enough from that file's that
 * it should not be read as one more instance of it.
 *
 * THIS PARSE IS STRICT — the inversion of the convention everywhere else in
 * this package, for the reason http/coverage.ts and http/verdict.ts already
 * invert it. Elsewhere a missing count defaults to zero, because a missing
 * count there costs a line of text. Here the zero IS the claim: "missed 0",
 * "surfaced 0", "hit 0". A count that did not arrive and reads as zero is
 * AT-9's exact failure — an unmeasured figure looking like a perfect one — on
 * the one report whose purpose is to say whether this product works. So no
 * count has a default, and a report with one missing is a report this client
 * cannot read, which the command says rather than printing a number nobody
 * measured.
 *
 * WHAT STAYS OPEN is what a newer hub may legitimately add without changing
 * any figure's meaning: a reason word this client has no sentence for, a
 * channel it has not heard of, a field it does not know (`looseObject`). The
 * renderer prints each as itself.
 */
import { z } from "zod";

import { hubRequest } from "./client.ts";
import type { HubContext, HubResult } from "./client.ts";

const CountSchema = z.number().int().min(0);

/**
 * `measured` with a value, or `unavailable` with the hub's reason — never a
 * bare number. The reason is an OPEN string: the vocabulary is
 * `PILOT_UNAVAILABLE_REASONS` in `@crosscheck/schema`, and a word this client
 * has no sentence for is printed as the word.
 */
export const PilotFigureSchema = z.discriminatedUnion("kind", [
  z.looseObject({
    kind: z.literal("measured"),
    value: z.number().finite().min(0),
  }),
  z.looseObject({
    kind: z.literal("unavailable"),
    reason: z.string().min(1),
  }),
]);

export type PilotFigure = z.infer<typeof PilotFigureSchema>;

const PriorWorkSchema = z.looseObject({
  workContextId: z.string().min(1),
  title: z.string(),
  openedBySessions: CountSchema,
});

const RepairSchema = z.looseObject({
  pinId: z.string().min(1),
  repairPinId: z.string().min(1),
  brokenCommit: z.string().min(1),
  repairCommit: z.string().min(1),
  namedFiles: z.array(z.string().min(1)),
});

export type PilotRepair = z.infer<typeof RepairSchema>;

export const PilotReportSchema = z.looseObject({
  repo: z.string().min(1),
  enrolled: z.boolean(),
  sinceIso: z.string().min(1),
  untilIso: z.string().min(1),
  days: z.number().int().min(1),
  sessionSet: z.looseObject({
    used: CountSchema,
    cap: CountSchema,
    refused: CountSchema,
    spanned: CountSchema,
    restarted: CountSchema,
    notRecorded: CountSchema,
  }),
  duplicateWork: z.looseObject({
    surfaced: CountSchema,
    opened: CountSchema,
    converged: CountSchema,
    byChannel: z.record(z.string(), CountSchema),
    priorWork: z.array(PriorWorkSchema),
    priorWorkBeyondList: CountSchema,
    openedAnyway: CountSchema,
  }),
  collisions: z.looseObject({
    tripwireFlagged: PilotFigureSchema,
    ghostFlagged: PilotFigureSchema,
    bothLanded: PilotFigureSchema,
    ciRegressed: PilotFigureSchema,
  }),
  attribution: z.looseObject({
    answers: CountSchema,
    attributions: CountSchema,
    excluded: CountSchema,
    repaired: z.array(RepairSchema),
    repairedBeyondBound: CountSchema,
    noRepairYet: CountSchema,
  }),
  precision: z.looseObject({
    sessions: CountSchema,
    openedPer100: PilotFigureSchema,
    openedTargetPer100: z.number().finite().min(0),
    offTargetMarks: CountSchema,
    offTargetPer100: PilotFigureSchema,
    offTargetCeilingPer100: z.number().finite().min(0),
    surfaceOkMarks: CountSchema,
  }),
  integrity: z.array(
    z.looseObject({
      surface: z.string().min(1),
      // NULLABLE, NEVER DEFAULTED (PIL-4): `null` is a surface nobody
      // counted; `{}` would be a surface that answered nothing.
      counters: z.record(z.string(), CountSchema).nullable(),
    }),
  ),
});

export type PilotReport = z.infer<typeof PilotReportSchema>;

export interface PilotReportRequest {
  readonly repo: string;
  /** Omitted: the hub's own default window (PILOT_REPORT_DEFAULT_WINDOW_DAYS). */
  readonly days?: number;
}

export const getPilotReport = (
  ctx: HubContext,
  request: PilotReportRequest,
): Promise<HubResult<PilotReport>> => {
  const days =
    request.days === undefined ? "" : `&days=${String(request.days)}`;
  return hubRequest(ctx, {
    method: "GET",
    path: `/api/pilot/report?repo=${encodeURIComponent(request.repo)}${days}`,
    schema: PilotReportSchema,
  });
};
