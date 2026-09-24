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
import { PILOT_MARK_BY_REF_KIND, PIN_PRESENCE_TERMINAL } from "@crosscheck/schema";
import type { PilotMarkRefKind } from "@crosscheck/schema";

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
  pinnedFiles: z.array(z.string().min(1)),
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
    repairedWithoutBreakCommit: CountSchema,
    supersededAnswers: CountSchema,
    answersAfterRepair: CountSchema,
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

// ── The two human gestures (07 §3.2) ────────────────────────────────────────

const MarkResultSchema = z.looseObject({
  id: z.string().min(1),
  /** The person had said this already; it still counts once. */
  repeated: z.boolean(),
});

export type MarkResult = z.infer<typeof MarkResultSchema>;

export interface PilotMarkRequest {
  readonly repo: string;
  readonly refKind: PilotMarkRefKind;
  readonly refId: string;
}

/**
 * One person's one word about one thing. The WORD is derived from what the
 * mark is about, never chosen by the caller: a delivery takes `off_target`,
 * a pin takes `surface_ok` (PILOT_MARK_BY_REF_KIND), so a crossed pair has no
 * way to be sent. `presence` states what this process observed — a person at
 * a terminal — and the hub stamps what that is worth.
 *
 * NO AGENT PATH IN THIS PRODUCT'S CODE REACHES THIS (07 PIL-6, D3). An agent
 * marking the product's own interventions off-target would be the product
 * grading itself, so the only callers are the two human commands, each behind
 * the TTY gate — and the complete list of callers is pinned, so the day an MCP
 * tool gains one, CI goes red instead of the pilot quietly measuring the
 * model's taste.
 *
 * WHAT THIS DOES NOT STOP, stated rather than implied (adversarial review):
 * an agent that wraps the command in a pty (`script -q /dev/null crosscheck
 * noise`) passes the TTY check, and anybody holding the key can POST the route
 * directly. Neither is prevented; both are ATTRIBUTABLE, because every mark
 * names who made it. The pin below is about this codebase's own paths:
 *
 * VERIFY: grep -rl postPilotMark packages --include='*.ts' | grep /src/ | sort
 * PRINTS: packages/cli/src/cli/noise.ts
 * PRINTS: packages/cli/src/cli/pin.ts
 * PRINTS: packages/connector-core/src/http/pilot.ts
 */
export const postPilotMark = (
  ctx: HubContext,
  request: PilotMarkRequest,
): Promise<HubResult<MarkResult>> =>
  hubRequest(ctx, {
    method: "POST",
    path: "/api/pilot-marks",
    schema: MarkResultSchema,
    body: {
      repo: request.repo,
      refKind: request.refKind,
      refId: request.refId,
      mark: PILOT_MARK_BY_REF_KIND[request.refKind],
      presence: PIN_PRESENCE_TERMINAL,
    },
  });

const MarkCandidateSchema = z.looseObject({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  channel: z.string().min(1),
  refKind: z.string().min(1),
  refId: z.string().min(1),
  deliveredAt: z.string().min(1),
});

export type MarkCandidate = z.infer<typeof MarkCandidateSchema>;

const MarkCandidatesSchema = z.looseObject({
  candidates: z.array(MarkCandidateSchema),
  more: z.boolean(),
});

export type MarkCandidates = z.infer<typeof MarkCandidatesSchema>;

export interface MarkCandidatesRequest {
  readonly repo: string;
  /** The hub session ids live on this machine; omitted, every one of the caller's. */
  readonly sessions?: readonly string[];
  /** The work-context or claim id the person saw printed in a hint. */
  readonly ref?: string;
  /** Omitted: the hub's widest window, which is retention. */
  readonly withinMinutes?: number;
}

/** Which of the caller's own unasked deliveries `crosscheck noise` could mean. */
export const getMarkCandidates = (
  ctx: HubContext,
  request: MarkCandidatesRequest,
): Promise<HubResult<MarkCandidates>> => {
  const query = [
    `repo=${encodeURIComponent(request.repo)}`,
    ...(request.sessions ?? []).map(
      (session) => `session=${encodeURIComponent(session)}`,
    ),
    ...(request.ref === undefined
      ? []
      : [`ref=${encodeURIComponent(request.ref)}`]),
    ...(request.withinMinutes === undefined
      ? []
      : [`withinMinutes=${String(request.withinMinutes)}`]),
  ].join("&");
  return hubRequest(ctx, {
    method: "GET",
    path: `/api/pilot-marks/candidates?${query}`,
    schema: MarkCandidatesSchema,
  });
};
