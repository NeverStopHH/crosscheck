import { z } from "zod";

export const CLAIM_KINDS = [
  "observation",
  "hypothesis",
  "evidence",
  "root_cause",
  "decision",
  "rejected_approach",
] as const;

export const CLAIM_STATUSES = [
  "proposed",
  "partially_confirmed",
  "likely_root_cause",
  "rejected",
  "superseded",
] as const;

export const EDGE_KINDS = [
  "supports",
  "contradicts",
  "deeper_cause_of",
  "supersedes",
  "relates_to",
] as const;

export const SESSION_STATUSES = [
  "analyzing",
  "planning",
  "implementing",
  "testing",
  "blocked",
  "done",
] as const;

export const CAPTURE_MODES = ["auto", "agent", "human"] as const;

/**
 * The capture modes a CLAIM may carry (1.0 spec 08 §3.2a, AT-3's write path).
 *
 * `human` IS ABSENT, AND ITS ABSENCE IS THE POINT. `capture_mode` is a TRUST
 * LABEL: a reader meeting `human` reads the sentence as a person's word. No
 * writer in this tree has ever produced it on a claim — seven stamp a mode,
 * four `agent` and three `auto`, and zero `human` (08 §1.3) — but the field
 * rode the wire verbatim into the row (`record-handlers.ts`), so a hand-rolled
 * POST under a developer bearer key could mint one, and that key sits in
 * plaintext in `~/.crosscheck/config.json` where any agent on the machine can
 * read it. Narrowing the vocabulary makes the forgery UNSAYABLE rather than
 * merely unsaid: a body naming it fails at the boundary with the field named.
 *
 * REFUSED, NOT DOWNGRADED — the second half of AT-3's sentence. A claim body
 * is parsed by `ClaimSchema` before ingest, so `human` is a parse failure and
 * never reaches a row. It is NOT quietly rewritten to `agent`, which would
 * leave the caller believing a human's word had been recorded.
 *
 * WHY THIS IS A NARROWER ENUM AND NOT THE HUB STAMP 08 §3.2a ASKS FOR.
 * The spec says the hub should stamp the mode "from the route and the
 * producer", modelled on #50's pins, where the hub stamps `human` and the body
 * may never carry it. That does not transfer, and the difference is measurable
 * rather than a matter of taste. A pin has ONE legal value, so a stamp needs no
 * information. A claim has two, and nothing at the boundary separates them:
 * both lanes land on the same route — the MCP tools post to `/api/records`
 * through `postRecords`, the derived writers reach the same handler through the
 * spool flush — and both carry the identical `producer` block, because the same
 * session runs both. A hub stamping this field would be guessing.
 *
 * Nor is it derivable from `provenance`, which is the obvious next idea: six of
 * the seven writers do pair `derived→auto` and `declared→agent`, but
 * `review-draft.ts` breaks it deliberately. A DISCARDED draft is `agent` +
 * `derived` — the agent ACTED on it but did not VOUCH for it — and that pairing
 * is the record of a real event. Deriving the label from provenance would
 * relabel every discard as `auto` and erase the agent from it.
 *
 * So the two values stay sender-chosen, and the honest statement of what that
 * buys is narrow: this stops the forgery of a HUMAN's word, which is the trust
 * escalation, and it does not stop a lying agent from writing `auto` on its own
 * declaration. That second one is a step DOWN in authority, and it is the WHO
 * axis of 08 §3.1 — derived fresh per read — that answers it, not this enum.
 */
export const CLAIM_CAPTURE_MODES = ["auto", "agent"] as const;

export const PROVENANCES = ["declared", "derived"] as const;

export const TARGET_KINDS = [
  "file",
  "symbol",
  "component",
  "error_fingerprint",
] as const;

/**
 * WHERE a file target came from (regression-guard Stage 1). Two sources,
 * because they fail in opposite directions: the tool lane sees an `Edit` the
 * host reported and nothing a Bash command did, while the git lane sees every
 * working-tree change at Stop and cannot tell which tool made it. `sed -i`,
 * codemods, `prettier --write` and generators are invisible to the first,
 * which is exactly how a ranking built on it alone names the session that
 * used Edit while the codemod session leaves no trace at all.
 */
export const TARGET_SOURCES = ["tool_edit", "git_diff"] as const;

/**
 * WHICH SURFACE HANDED A REF TO A READER (1.0 spec 07 §3.1).
 *
 * `hint_deliveries` counts `delivered / pulled` as one number over channels
 * that are not comparable. A briefing arrives at SessionStart, unasked, into
 * a budget every teammate shares; a mid-prompt hint interrupts a turn already
 * under way. A pull rate that mixes them answers no question about either —
 * and every one of the five pilot proofs needs the split, which is why it
 * lives here rather than being derived by whichever reader happens to care.
 *
 * `unknown` IS THE HONEST DEFAULT, NEVER A PLACEHOLDER. Two writers exist
 * today and a stored row cannot be attributed to either, so no back-fill is
 * possible and none is attempted: the report prints `unknown` as its own
 * bucket, the way the absence listing keeps `inactive` and `unconnected`
 * apart rather than guessing between them. A back-fill here would be this
 * spec inventing the very measurement it exists to take.
 *
 * `suspect` is listed although nothing writes it yet. The channel exists the
 * moment an attribution answer can hand somebody a ref, and adding the value
 * later would leave every row written before it indistinguishable from
 * `unknown` — the exact trap the two existing writers are already in.
 */
/**
 * WHY A SURFACE IS BELIEVED BROKEN, and WHAT the answer turned out to be.
 *
 * #50 declared these as union types in `server/services/suspect.ts`, which is
 * the right shape for a return value and the wrong one for a stored column: a
 * drizzle enum needs the values as data. 07 §3.3 stores both on
 * `pilot_attributions` and says they must be *"#50's enums verbatim, not a
 * parallel set"* — so the arrays live here, the union types are derived from
 * them, and `services/suspect.ts` re-exports those. One declaration, two
 * shapes, and no second list that can drift from the first.
 *
 * HERE RATHER THAN IN THE SERVICE, because `db/schema.ts` is the other reader
 * and it cannot import a service without a cycle — the services import the
 * tables. This package is the one place both sides already reach.
 */
/**
 * THE ONLY HUMAN INPUT THE PILOT TAKES (1.0 spec 07 §3.2), and it is never a
 * question.
 *
 * Two words, each riding a gesture somebody makes anyway. `off_target` is
 * typed beside a session that got a bad intervention; `surface_ok` is the
 * missing symmetric half of `crosscheck pin --broke` — whoever ran the recipe
 * and watched it PASS gets the same one-line gesture as whoever watched it
 * fail, which is what makes a pin falsifiable in both directions.
 *
 * NO SURVEY, NO FREE TEXT, NO PROMPT. §8.3 refuses to add one: a measurement
 * that interrupts somebody to ask how the measurement is going has changed
 * the thing it measures, and a free-text field would put a person's prose on
 * a surface data minimisation keeps to ids, enums and timestamps.
 *
 * MARKS ARE VOLUNTARY, so the proactive-precision figure has a FLOOR and not
 * a value: nobody is obliged to mark anything, so an absence of marks is an
 * absence of evidence and never evidence of no noise. The report says so on
 * the line itself.
 */
export const PILOT_MARKS = ["off_target", "surface_ok"] as const;

/** What a mark can be ABOUT — a delivery somebody received, or a pin. */
export const PILOT_MARK_REF_KINDS = ["hint_delivery", "pin"] as const;

/**
 * EACH REF KIND TAKES EXACTLY ONE WORD, because each has exactly one gesture:
 * `crosscheck noise` sends `off_target` about a delivery, `crosscheck pin --ok`
 * sends `surface_ok` about a pin. The report counts marks by their word, so a
 * crossed pair — noise about a pin, "ok" about a delivery — would land in the
 * wrong proof with nothing to show it had.
 */
export const PILOT_MARK_BY_REF_KIND = {
  hint_delivery: "off_target",
  pin: "surface_ok",
} as const satisfies Record<
  (typeof PILOT_MARK_REF_KINDS)[number],
  (typeof PILOT_MARKS)[number]
>;

/**
 * HOW A SESSION ENDED, and the distinction is the whole reason the pilot
 * stores it (07 §3.6).
 *
 * `reported` means the connector said so; `reaped` means the hub inferred it
 * from silence. The trial found 104 of 127 sessions never closed, so a
 * measurement that counted the two as one would be counting mostly the
 * second and calling it the first.
 */
export const PILOT_END_REASONS = ["reported", "reaped"] as const;

export const SUSPECT_FALSIFIER_KINDS = [
  /** A pin whose check recipe was run and recorded failing. */
  "recorded_break",
  /** A live pin: nobody has recorded running its check and failing. */
  "not_recorded_broken",
  /** A briefing-only pin with no recipe — nothing to have run. */
  "no_check_recipe",
  /** No pin at all: the reader named the files, so the reader is the falsifier. */
  "reader_named_files",
] as const;

export const SUSPECT_OUTCOMES = [
  /** A separated top candidate; rows printed with scores. */
  "ranked",
  /** Rows printed with scores, and no clear air between the top two. */
  "no_separation",
  /** Nothing touched these files in the window. */
  "no_touch",
  /** The falsifier gate, or this team's attribution setting, printed no rows. */
  "withheld",
] as const;

export const DELIVERY_CHANNELS = [
  "unknown",
  "briefing",
  "prompt_hint",
  "tripwire",
  "suspect",
] as const;

/**
 * THE CHANNEL A READER ASKED FOR. Every other channel arrives unasked; this
 * one is a pulled answer, so it is neither a proactive pointer (proof 4) nor
 * something a person can call noise — a pulled answer somebody disliked is a
 * verdict on the answer, and counting it as an interruption would make asking
 * a question the way to inflate the noise figure.
 */
export const PULLED_DELIVERY_CHANNEL = "suspect" as const satisfies
  (typeof DELIVERY_CHANNELS)[number];

/**
 * WHY A PILOT FIGURE COULD NOT BE MEASURED (1.0 spec 07 §5) — an enum, so a
 * renderer never invents the reason and a reader always learns which of
 * several absences it was.
 *
 * HERE, not in the hub's report service, because both halves need the same
 * words: the hub decides which reason applies, the CLI turns each into the
 * sentence a person reads. A second copy in the connector would be a second
 * list to fall out of step, and a reason one side knows and the other does not
 * is exactly the unexplained gap this vocabulary exists to prevent.
 */
export const PILOT_UNAVAILABLE_REASONS = [
  /** The repo is not enrolled, or the surface counted nothing — never "missed 0". */
  "not_instrumented",
  /** A ghost line repeats for as long as the overlap lasts and is never recorded as a delivery. */
  "ghost_lines_not_recorded",
  /** No CI reporter writes to this hub, so no regression can be observed. */
  "no_ci_reporter",
  /** A per-100 rate over zero sessions. */
  "no_sessions",
  /** Nothing was flagged, so nothing can have landed. */
  "nothing_flagged",
] as const;

/**
 * THE REASONS THAT NAME A RUNG WHICH CANNOT EXIST HERE, as opposed to a figure
 * that is merely empty today (07 §8.6, PIL-8).
 *
 * `nothing_flagged` and `no_sessions` will change on their own the day
 * something happens; these two will not change until somebody builds or
 * installs something. That difference is what `doctor` prints: a rung that
 * cannot exist gets a PASS line with its reason, every time, and an empty day
 * gets no line at all — printing it would make an ordinary quiet morning read
 * like a missing capability.
 */
export const PILOT_RUNG_REFUSALS = [
  "ghost_lines_not_recorded",
  "no_ci_reporter",
] as const satisfies readonly (typeof PILOT_UNAVAILABLE_REASONS)[number][];

/**
 * What the HUB may hold. "both" is derived on ingest — never sent — when the
 * same (context, kind, value) arrives from the other lane: the primary key
 * collapses the two rows into one, and without this third value whichever
 * lane arrived first would silently own the label.
 */
export const STORED_TARGET_SOURCES = [...TARGET_SOURCES, "both"] as const;

/**
 * HOW PRECISELY we know which commit a claim was observed at (1.0 spec 02).
 *
 * Not a lane and not a source — `work_context_targets.source` says WHICH
 * OBSERVER saw a file, and folding the two into one enum is the defect spec
 * 02 §9 names. This says how much the "when" is worth:
 *
 *   reported      — the emitter sent its own HEAD with the claim.
 *   session_base  — ingest fell back to the author session's base_commit.
 *                   An APPROXIMATION in BOTH directions, deliberately not
 *                   called a lower bound: a session re-registers on recovery
 *                   and on SessionStart re-fires, and each re-registration
 *                   REWRITES base_commit (server services/sessions.ts), so the
 *                   stored value can be later than the observation as easily
 *                   as earlier.
 *   none          — nothing usable reached the row, so the claim can never be
 *                   revalidated and is never unsolicited substance. Unknown
 *                   fails CLOSED on the code axis.
 */
export const CLAIM_COMMIT_BINDINGS = [
  "reported",
  "session_base",
  "none",
] as const;

/** Where a revalidation's file set came from — declared by the author, or the
 * whole work context's file targets, which OVER-fires by construction. */
export const CLAIM_REVALIDATION_BASES = ["declared", "context_targets"] as const;

/**
 * What a revalidation found. `SolvedFileDrift`'s three states VERBATIM
 * (connector-core git/solved-staleness.ts) — one vocabulary for "did the code
 * move", with `unknown` first-class, and deliberately NOT `PinPathStatus`
 * (present|missing|unknown), which is a different question about a different
 * object.
 */
export const CLAIM_REVALIDATION_RESULTS = [
  "changed",
  "unchanged",
  "unknown",
] as const;

/**
 * HOW MUCH A RECORDED CLAIM IS STILL WORTH ABOUT THE CODE (1.0 spec 02 §3.5).
 *
 * Five states, derived on read by ONE function — server
 * services/claim-validity.ts — and never stored. The vocabulary lives here so
 * the hub and every connector spell it identically; the RESOLUTION lives there
 * so there is one place that decides.
 *
 *   current      a revalidation looked and the surface had not moved
 *   superseded   a `supersedes` edge points at this claim
 *   invalidated  the author set status `rejected`
 *   stale        a revalidation looked and the surface HAD moved
 *   unknown      nobody looked, the look failed, or the claim is bound to
 *                no commit at all
 */
export const CLAIM_VALIDITY_STATES = [
  "current",
  "superseded",
  "invalidated",
  "stale",
  "unknown",
] as const;

export const ARTIFACT_SENSITIVITIES = [
  "team_visible",
  "needs_approval",
] as const;

export const ClaimKindSchema = z.enum(CLAIM_KINDS);
export const ClaimCommitBindingSchema = z.enum(CLAIM_COMMIT_BINDINGS);
export const ClaimValidityStateSchema = z.enum(CLAIM_VALIDITY_STATES);
export const ClaimRevalidationBasisSchema = z.enum(CLAIM_REVALIDATION_BASES);
export const ClaimRevalidationResultSchema = z.enum(CLAIM_REVALIDATION_RESULTS);
export const ClaimStatusSchema = z.enum(CLAIM_STATUSES);
export const EdgeKindSchema = z.enum(EDGE_KINDS);
export const SessionStatusSchema = z.enum(SESSION_STATUSES);
export const CaptureModeSchema = z.enum(CAPTURE_MODES);
export const DeliveryChannelSchema = z.enum(DELIVERY_CHANNELS);
export const ClaimCaptureModeSchema = z.enum(CLAIM_CAPTURE_MODES);
export const ProvenanceSchema = z.enum(PROVENANCES);
export const TargetKindSchema = z.enum(TARGET_KINDS);
export const TargetSourceSchema = z.enum(TARGET_SOURCES);
export const ArtifactSensitivitySchema = z.enum(ARTIFACT_SENSITIVITIES);

export type ClaimKind = z.infer<typeof ClaimKindSchema>;
export type ClaimCommitBinding = z.infer<typeof ClaimCommitBindingSchema>;
export type ClaimValidityState = z.infer<typeof ClaimValidityStateSchema>;
export type ClaimRevalidationBasis = z.infer<typeof ClaimRevalidationBasisSchema>;
export type ClaimRevalidationResult = z.infer<typeof ClaimRevalidationResultSchema>;
export type ClaimStatus = z.infer<typeof ClaimStatusSchema>;
export type EdgeKind = z.infer<typeof EdgeKindSchema>;
export type SessionStatus = z.infer<typeof SessionStatusSchema>;
export type CaptureMode = z.infer<typeof CaptureModeSchema>;
export type ClaimCaptureMode = z.infer<typeof ClaimCaptureModeSchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;
export type TargetKind = z.infer<typeof TargetKindSchema>;
export type TargetSource = z.infer<typeof TargetSourceSchema>;
export type StoredTargetSource = (typeof STORED_TARGET_SOURCES)[number];
export type ArtifactSensitivity = z.infer<typeof ArtifactSensitivitySchema>;

export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];


export type SuspectFalsifierKind = (typeof SUSPECT_FALSIFIER_KINDS)[number];
export type SuspectOutcome = (typeof SUSPECT_OUTCOMES)[number];

export type PilotMark = (typeof PILOT_MARKS)[number];
export type PilotMarkRefKind = (typeof PILOT_MARK_REF_KINDS)[number];
export type PilotEndReason = (typeof PILOT_END_REASONS)[number];
export type PilotUnavailableReason =
  (typeof PILOT_UNAVAILABLE_REASONS)[number];
