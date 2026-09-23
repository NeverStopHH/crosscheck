/**
 * The verdict as it arrives on the wire (04 §3, §5).
 *
 * IT INHERITS COVERAGE'S INVERTED PARSE RULE, for coverage's reason. This
 * tree's convention is that a missing optional block means "nothing is
 * claimed" and the renderer prints nothing. For a verdict, printing nothing IS
 * the failure, and more sharply than for coverage: `suspect` without a verdict
 * is a ranking of sessions with no statement of whether anybody may be named —
 * which is precisely the unqualified naming 04 exists to refuse. Silence would
 * leave the pre-04 answer standing and read as a fully qualified one.
 *
 *   An absent verdict is SAID, never silent. It is never invented either.
 *
 * So `parseVerdict` returns `null` for an absent or unreadable block, and the
 * renderer is required to print a line saying so. What it must NOT do is
 * fabricate an `INDETERMINATE` and pass it off as the hub's answer: a verdict
 * this client made up is indistinguishable, to every reader downstream, from
 * one the hub computed. Missing evidence may weaken a conclusion; it must
 * never strengthen one, and it must never impersonate one.
 *
 * THE NAMES ARE THE HUB'S (packages/server/src/services/verdict.ts), not a
 * second vocabulary. They are re-declared here because the connector cannot
 * import the server — a static import would pull PGlite, drizzle and hono into
 * a render path — and test/verdict-wire.test.ts pins the five enums against
 * the hub's own so drift is a red build rather than a review catch. Exactly
 * the arrangement http/coverage.ts already runs.
 */
import { z } from "zod";

export const ATTRIBUTIONS = [
  "ATTRIBUTED",
  "UNATTRIBUTED",
  "INDETERMINATE",
] as const;

export const PROTECTIONS = [
  "unprotected",
  "protected_ok",
  "PROTECTED_CONFLICT",
] as const;

export const BEHAVIOR_DELTAS = ["confirmed", "unconfirmed", "flaky"] as const;

export const VERDICT_FALSIFIERS = [
  "recorded_break",
  "not_recorded_broken",
  "no_check_recipe",
  "reader_named_files",
  "ci_confirmed_regression",
] as const;

export const VERDICT_BASES = [
  "separated",
  "no_separation",
  "no_touch_complete",
  "coverage_gap",
  "pin_paths_missing",
  "falsifier_absent",
  "no_check_recipe",
  "attribution_withheld_by_team",
  "delta_flaky",
  "delta_unconfirmed",
  "ci_no_surface",
  "reader_named",
  "legality_violation",
] as const;

export type Attribution = (typeof ATTRIBUTIONS)[number];
export type Protection = (typeof PROTECTIONS)[number];
export type BehaviorDelta = (typeof BEHAVIOR_DELTAS)[number];
export type VerdictFalsifier = (typeof VERDICT_FALSIFIERS)[number];
export type VerdictBasis = (typeof VERDICT_BASES)[number];

/** Which pinned invariant, at which version, the verdict is about (§3.5). */
export interface InvariantRef {
  readonly pinId: string;
  readonly version: number;
}

/**
 * The open fence, if there is one.
 *
 * `reason` is AUTHOR-WRITTEN — one developer's prose, reaching every reader of
 * `suspect` and `pin list`. It is the slot 04 §5 names as the one the corpus
 * must attack, and every renderer of this type frames it.
 */
export interface WaiverRef {
  readonly id: string;
  readonly pinVersion: number;
  readonly expiresAt: string;
  readonly reason: string;
  readonly grantedByName: string;
}

/**
 * What a reader is owed about one surface.
 *
 * WIRE-TOLERANT ON PURPOSE, the convention of every type in this directory: a
 * hub newer than this client may name an attribution, a basis or a falsifier
 * this build has never heard of, and the honest reading of that is the word
 * itself rather than a parse failure that costs the whole answer. The enums
 * above are what this client can SPELL A SENTENCE for; the strings here are
 * what it can RECEIVE. A renderer that meets an unknown word prints it as a
 * word and says it has no sentence for it.
 */
export interface VerdictView {
  readonly attribution: string;
  readonly protection: string;
  readonly basis: string;
  readonly falsifier: string;
  readonly behaviorDelta: string;
  readonly deltaLane: string;
  readonly deltaReason: string;
  readonly explanationTiming: string;
  readonly timingReason: string;
  readonly invariant: InvariantRef | null;
  readonly waiver: WaiverRef | null;
  readonly computedAt: string | null;
}

const InvariantSchema = z.looseObject({
  pinId: z.string().min(1),
  version: z.number().int().min(1),
});

/**
 * Exported because `pin list` carries the same open fence on its own rows
 * (04 §5) — one shape, so a waiver cannot mean two things depending on which
 * command a reader typed.
 */
export const WaiverRefSchema = z.looseObject({
  id: z.string().min(1),
  pinVersion: z.number().int().min(1),
  expiresAt: z.string().min(1),
  // DEFAULTED, not required. A hub that sends a waiver without its reason has
  // still told this client the fence is open, and dropping the whole waiver
  // over a missing sentence would report an open fence as a closed one — the
  // unsafe direction. The empty string renders as "no reason recorded".
  reason: z.string().default(""),
  grantedByName: z.string().default(""),
});

const VerdictSchema = z
  .looseObject({
    attribution: z.string().min(1),
    protection: z.string().min(1),
    basis: z.string().min(1),
    falsifier: z.string().min(1),
    behaviorDelta: z.string().min(1).default("unconfirmed"),
    deltaLane: z.string().min(1).default("pin"),
    deltaReason: z.string().min(1).default("insufficient_base"),
    explanationTiming: z.string().min(1).default("absent"),
    timingReason: z.string().min(1).default("no_intent"),
    invariant: InvariantSchema.nullish(),
    waiver: WaiverRefSchema.nullish(),
    computedAt: z.string().nullish(),
  })
  .transform(
    (value): VerdictView => ({
      attribution: value.attribution,
      protection: value.protection,
      basis: value.basis,
      falsifier: value.falsifier,
      behaviorDelta: value.behaviorDelta,
      deltaLane: value.deltaLane,
      deltaReason: value.deltaReason,
      explanationTiming: value.explanationTiming,
      timingReason: value.timingReason,
      invariant: value.invariant ?? null,
      waiver: value.waiver ?? null,
      computedAt: value.computedAt ?? null,
    }),
  );

/**
 * The hub's verdict, or `null` when there is none this client can read.
 *
 * The four required words are required for a reason: an object that cannot say
 * what the attribution, the protection, the basis and the falsifier are is not
 * a partial verdict, it is a different message. Reading it as a verdict with
 * blanks would put this client's own defaults on the hub's authority.
 */
export const parseVerdict = (raw: unknown): VerdictView | null => {
  const parsed = VerdictSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};
