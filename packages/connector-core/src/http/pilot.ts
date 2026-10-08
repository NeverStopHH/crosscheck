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
import { PIN_PRESENCE_TERMINAL } from "@crosscheck/schema";
import type { PilotInterventionLabel } from "@crosscheck/schema";

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

/**
 * THE FOUR LABELLED FIGURES over one population (07 §12) — the window, or
 * one cohort. Every tally is a count with no default, for the header's
 * reason: "helpful 0" beside a real "noise 10" is the lie this parse exists
 * to refuse. The four ratios are figures, each measured or saying why not.
 */
const LabelFiguresSchema = z.looseObject({
  sessions: CountSchema,
  interventions: CountSchema,
  helpful: CountSchema,
  noise: CountSchema,
  unclear: CountSchema,
  labelled: CountSchema,
  benefitPer100: PilotFigureSchema,
  burdenPer100: PilotFigureSchema,
  precision: PilotFigureSchema,
  labelCoverage: PilotFigureSchema,
});

export type PilotLabelFigures = z.infer<typeof LabelFiguresSchema>;

/**
 * THE OUTCOMES BLOCK (07 §13.9–§13.11). Strict inside — a count that did not
 * arrive is not zero, and figures beside "withheld" are not printed — but
 * strict about ITSELF only: a block this client cannot read is answered as
 * unreadable, and the rest of the report is still read (round 3).
 */
const OutcomeBlockSchema = z
  .looseObject({
    periodStartIso: z.string().min(1),
    periodEndIso: z.string().min(1),
    recordableSinceIso: z.string().nullable(),
    countedFromIso: z.string().nullable(),
    /** 07 §13.11 (review M3): the pilot paused inside the counted part. Absent from an older hub, which never paused. */
    pausedInPeriod: z.boolean().optional(),
    /** 07 §13.12 (review M-3): counted over an enrolment an upgrade reconstructed. Absent from an older hub. */
    reconstructed: z.boolean().optional(),
    withheld: z.string().min(1).nullable(),
    // 07 §13.11 (review M1): every count, the interventions too, rides only inside the figures.
    figures: z
      .looseObject({
        interventions: CountSchema,
        followed: CountSchema,
        overrode: CountSchema,
        notRelevantNow: CountSchema,
        noise: CountSchema,
        unmarked: CountSchema,
      })
      .nullable(),
  })
  .refine((block) => (block.withheld === null) === (block.figures !== null), {
    message: "an outcome figure is either withheld or shown",
  });

export type OutcomeBlock = z.infer<typeof OutcomeBlockSchema>;

/** A block this client could not read — said as such, never read as anything. */
export interface UnreadableBlock {
  readonly unreadable: true;
}

export const UNREADABLE_BLOCK: UnreadableBlock = { unreadable: true };

const readOutcomeBlock = (raw: unknown): OutcomeBlock | UnreadableBlock => {
  const parsed = OutcomeBlockSchema.safeParse(raw);
  return parsed.success ? parsed.data : UNREADABLE_BLOCK;
};

/**
 * One sentence somebody typed beside a label. The LABEL is an open string:
 * the vocabulary is `PILOT_INTERVENTION_LABELS`, and a word this client has
 * no sentence for is printed as the word, cleaned, like a reason word.
 */
const LabelReasonSchema = z.looseObject({
  label: z.string().min(1),
  reason: z.string(),
});

export type PilotLabelReason = z.infer<typeof LabelReasonSchema>;

const CohortFiguresSchema = LabelFiguresSchema.extend({
  cohort: z.string().min(1),
  cap: CountSchema,
});

export type PilotCohortFigures = z.infer<typeof CohortFiguresSchema>;

export const PilotReportSchema = z.looseObject({
  repo: z.string().min(1),
  enrolled: z.boolean(),
  /** When labels became available on this repo; null when it was never enrolled (07 §12). */
  labelsSinceIso: z.string().nullable(),
  sinceIso: z.string().min(1),
  untilIso: z.string().min(1),
  days: z.number().int().min(1),
  sessionSet: z.looseObject({
    used: CountSchema,
    cap: CountSchema,
    refused: CountSchema,
    /** A 0.10 hub's refusals under its old fifty-session cap — never "full" at this one (M2). */
    legacyRefused: CountSchema,
    /** Sessions that started before labels were available: outside the set (M4). */
    beforeLabels: CountSchema,
    discovery: CountSchema,
    discoveryCap: CountSchema,
    replication: CountSchema,
    replicationCap: CountSchema,
    /** Rows a 0.10 hub wrote, in neither cohort — strict, so "0" is never a guess. */
    legacy: CountSchema,
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
    /** Human provenance §5: repaired breaks no passkey confirmed. Absent from an older hub. */
    notHumanConfirmed: CountSchema.optional(),
  }),
  precision: LabelFiguresSchema.extend({
    /** Where the labelled figures start; null when nothing is measured. */
    labelledSinceIso: z.string().nullable(),
    /** 0.10 `off_target` marks, outside precision (second review, H1). */
    legacyNoise: CountSchema,
    /**
     * Human provenance §5: labels that are no person's judgement yet, by class.
     * Absent from an older hub; a block this client cannot read is dropped.
     */
    notHuman: z
      .looseObject({
        atTerminal: CountSchema,
        byAgent: CountSchema,
        legacy: CountSchema,
        /** Review H1: confirmed with a passkey still cooling off — counted from `countingFrom`. */
        coolingOff: CountSchema.optional().catch(undefined),
        countingFrom: z.string().nullable().optional().catch(undefined),
        /** Confirmed with a passkey since revoked: retracted. */
        retracted: CountSchema.optional().catch(undefined),
      })
      .optional()
      .catch(undefined),
    precisionTarget: z.number().finite().min(0).max(1),
    openedPer100: PilotFigureSchema,
    openedTargetPer100: z.number().finite().min(0),
    noisySessionsPer100: PilotFigureSchema,
    noisySessionsCeilingPer100: z.number().finite().min(0),
    surfaceOkMarks: CountSchema,
    reasons: z.array(LabelReasonSchema),
    reasonsBeyondList: CountSchema,
  }),
  // 07 §13.9 (D-O5). OPTIONAL, unlike every count inside it: an older hub
  // sends no block at all and the report says "this hub does not record
  // them"; a hub that sends one sends every count, none defaulted, because
  // "followed 0" read from a missing count is the AT-9 failure again.
  // Review #4: ONE CLOSED MONTH, and figures only above the disclosure
  // minimums — `withheld` says why not, as an open word. 07 §13.11 (round 3):
  // parsed LENIENTLY as a block — one this client cannot read, figures and
  // withholding disagreeing included, is an "unreadable" block, never a
  // report rejected whole, and never zeros.
  outcomes: z.unknown().transform(readOutcomeBlock).optional(),
  // THE LIST MUST ARRIVE: a list that did not is a report this client cannot
  // read, for the same reason as a missing count. Its ENTRIES are printed as
  // the hub sent them — the hub sends both cohorts; this parse does not
  // insist on two, so a newer hub's third would print rather than fail.
  cohorts: z.array(CohortFiguresSchema),
  integrity: z.array(
    z.looseObject({
      surface: z.string().min(1),
      // NULLABLE, NEVER DEFAULTED (PIL-4): `null` is a surface nobody
      // counted; `{}` would be a surface that answered nothing.
      counters: z.record(z.string(), CountSchema).nullable(),
    }),
  ),
  /** Human provenance §9: where a passkey can confirm anything on this hub. Absent from an older hub. */
  humanConfirmation: z.enum(["https", "hub_machine_only", "none"]).optional().catch(undefined),
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
  /** 07 §13.11 (H2), a noise label on a delivery: what the pointer stands at now. Absent from an older hub. */
  stands: z.string().min(1).nullable().optional(),
  /** What stood before the label — an outcome it now stands over, the label itself, or nothing. */
  replaced: z.string().min(1).nullable().optional(),
  /**
   * Human provenance §3: the label was DRAFTED — it counts once the person
   * confirms it with their passkey. Absent from an older hub, where it counted at once.
   */
  draft: z.boolean().optional(),
});

export type MarkResult = z.infer<typeof MarkResultSchema>;

/**
 * WHAT A MARK IS ABOUT DECIDES WHAT IT MAY SAY. A pin takes one word,
 * `surface_ok`, and no sentence; a delivery takes one of the three labels
 * (07 §12) and, optionally, one bounded reason. The two shapes are two
 * members of a union rather than optional fields, so a crossed pair — a
 * label about a pin, a reason beside `pin --ok` — cannot be built.
 */
export type PilotMarkRequest =
  | { readonly repo: string; readonly refKind: "pin"; readonly refId: string }
  | {
      readonly repo: string;
      readonly refKind: "hint_delivery";
      readonly refId: string;
      readonly label: PilotInterventionLabel;
      readonly reason?: string;
    };

/**
 * One person's one word about one thing. `presence` states what this process
 * observed — a person at a terminal — and the hub stamps what that is worth.
 *
 * NO AGENT PATH IN THIS PRODUCT'S CODE REACHES THIS (07 PIL-6, D3). An agent
 * marking the product's own interventions off-target would be the product
 * grading itself, so the only callers are the three human commands, each
 * behind the TTY gate — and the complete list of callers is pinned, so the
 * day an MCP tool gains one, CI goes red instead of the pilot quietly
 * measuring the model's taste.
 *
 * WHAT THIS DOES NOT STOP, stated rather than implied (adversarial review):
 * an agent that wraps the command in a pty (`script -q /dev/null crosscheck
 * noise`) passes the TTY check, and anybody holding the key can POST the route
 * directly. Neither is prevented; both are ATTRIBUTABLE, because every mark
 * names who made it. The pin below is about this codebase's own paths:
 *
 * VERIFY: grep -rl postPilotMark packages --include='*.ts' | grep /src/ | sort
 * PRINTS: packages/cli/src/cli/noise.ts
 * PRINTS: packages/cli/src/cli/pilot-label.ts
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
      ...(request.refKind === "pin"
        ? { mark: "surface_ok" }
        : {
            mark: request.label,
            ...(request.reason === undefined ? {} : { reason: request.reason }),
          }),
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

const UnlabeledInterventionSchema = MarkCandidateSchema.extend({
  /** What was shown — a teammate's title, framed by the renderer — or null. */
  title: z.string().nullable(),
});

export type UnlabeledIntervention = z.infer<typeof UnlabeledInterventionSchema>;

const UnlabeledInterventionsSchema = z.looseObject({
  candidates: z.array(UnlabeledInterventionSchema),
  more: z.boolean(),
});

export type UnlabeledInterventions = z.infer<typeof UnlabeledInterventionsSchema>;

export interface UnlabeledInterventionsRequest {
  readonly repo: string;
  /** Omitted: the hub's widest window, which is retention. */
  readonly withinMinutes?: number;
}

/** What `crosscheck pilot label` walks: the caller's own unasked, unlabelled deliveries (07 §12). */
export const getUnlabeledInterventions = (
  ctx: HubContext,
  request: UnlabeledInterventionsRequest,
): Promise<HubResult<UnlabeledInterventions>> => {
  const window =
    request.withinMinutes === undefined
      ? ""
      : `&withinMinutes=${String(request.withinMinutes)}`;
  return hubRequest(ctx, {
    method: "GET",
    path: `/api/pilot-marks/unlabeled?repo=${encodeURIComponent(request.repo)}${window}`,
    schema: UnlabeledInterventionsSchema,
  });
};

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
