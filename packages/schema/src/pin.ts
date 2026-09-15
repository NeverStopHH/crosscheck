import { z } from "zod";

import { SAFE_ID_PATTERN, MAX_RECORD_ID_LENGTH } from "./question.ts";

/**
 * A PIN: a human's provenance-stamped statement that a named surface WORKS
 * right now — surface label, file set, who verified it, at which commit,
 * when, and a 30-second re-check recipe ("open /workbench, press Play").
 *
 * WHY A REGISTER AT ALL. The research question was "is this a deliberate fix
 * or an accidental touch", and no product in five surveyed families infers
 * deliberateness from a diff: every one manufactures a cheap human-owned
 * reference and compares against it (Jest's committed snapshot, Chromatic's
 * accepted baseline, cargo-semver-checks' version bump, Terraform's approved
 * plan). Pins are that reference for surfaces that have no test — SWE-bench's
 * PASS_TO_PASS set, written by hand.
 *
 * WHY NOT A CLAIM. Claims are FK-bound to a live `agent_sessions` row and a
 * work context, capped at 400 body chars, with `evidence_refs` constrained to
 * claim ids. A synthetic session minted to carry a pin would show up as a
 * PHANTOM TEAMMATE in presence, in briefings and in the tripwire. Pins get
 * their own table pair instead (server db/schema.ts `pins` + `pin_files`).
 *
 * THE HUMAN GATE IS AN EVIDENCE FIELD, and the hub owns the verdict. The wire
 * carries `presence` — what the client OBSERVED — and the hub stamps the
 * stored capture mode from it. It used to carry `captureMode: "human"`, which
 * is the caller's own conclusion about itself, printed back to every teammate
 * as "verified by Nick (a human, at a terminal)": a sentence a model could
 * write about Nick, which is the exact hole the trust critique found in
 * shipped 0.7.5's `review_draft`. The literal makes the gate fail CLOSED —
 * an absent or unknown value is a parse failure, never a default — and
 * PIN_PRESENCE_TERMINAL states what the gate is worth.
 */
export const MAX_PIN_SURFACE_CHARS = 120;

/**
 * The recipe has to fit on a terminal line beside the surface it falsifies,
 * and 30 seconds of instructions is one sentence: "open /workbench, press
 * Play". Long enough for two clauses, short enough that nobody writes a test
 * plan here — that is what a test is for.
 */
export const MAX_PIN_CHECK_CHARS = 200;

/**
 * Hard cap on a pin's file set. A pin over this is not a surface, it is an
 * area — and an area-sized pin makes every session that touches the area a
 * suspect, which is exactly the blast-radius over-approximation the design
 * killed (Google TAP: 5.5M affected tests analysed, 63K ever failing).
 */
export const MAX_PIN_FILES = 30;

/**
 * Hard cap on the file set ONE CLAIM may declare as its affected surface
 * (1.0 spec 02 §3.2). Inherited from MAX_PIN_FILES by NAME rather than
 * silently re-chosen: both answer "how big may a hand-declared surface be
 * before it is an area", and an area-sized surface makes every commit in the
 * area a downgrade.
 */
export const MAX_CLAIM_SURFACE_PATHS = MAX_PIN_FILES;

/**
 * At most five files may ever SPEAK. Larger pins stay briefing-only: they can
 * be listed and they can be looked up with `crosscheck suspect`, but they are
 * not eligible for the Stage-2 notice lane. The cap is the noise control that
 * lets Stage 2 exist at all.
 */
export const MAX_SPEAKING_PIN_FILES = 5;

/**
 * What the post-commit sweep found for one pinned path. "present" is a file
 * git still has at HEAD; "missing" is one it does not, and whose rename the
 * sweep could not follow unambiguously. There is deliberately no third value
 * for "renamed": a rename the sweep CAN follow rewrites the path in place, so
 * the pin keeps watching the same behaviour under its new name — a
 * "renamed" state would be a permanent scar for a resolved event.
 */
export const PIN_FILE_STATUSES = ["present", "missing"] as const;

export type PinFileStatus = (typeof PIN_FILE_STATUSES)[number];

/**
 * THE EVIDENCE A CLIENT MAY STATE about who is on the other end, and the only
 * value the hub accepts. It is EVIDENCE, not a verdict: the client says what
 * it observed — a controlling terminal, which an agent's Bash tool call does
 * not have — and the hub decides what to store from it. That split is the
 * whole difference from the field this replaces: `captureMode: "human"` was
 * the caller's own conclusion ABOUT ITSELF, which the hub then printed as
 * "verified by Nick (a human, at a terminal)".
 *
 * WHAT THIS DOES NOT DO, stated here so nobody believes it again: a bearer key
 * that can reach this route can also send this field, and the key sits in
 * plaintext in ~/.crosscheck/config.json. The gate makes the claim EXPLICIT,
 * REQUIRED and REFUSABLE at the hub, where every other gate in this product
 * lives; it does not make it unforgeable by an attacker who already holds the
 * developer's key. Closing THAT needs a credential an agent on the same
 * machine cannot read, which this schema does not invent.
 */
export const PIN_PRESENCE_TERMINAL = "controlling_terminal";

/** A repo-relative path is never long; the cap keeps one row renderable. */
export const MAX_PIN_PATH_CHARS = 300;

/**
 * Upper bound on path updates ONE sweep request may carry — a bound on the
 * REQUEST, never on the registry: a larger registry sweeps in more requests.
 *
 * IT LIVES IN THE SHARED SCHEMA because both ends have to agree about it. The
 * hub enforces it with zod `.max()`, which REJECTS a whole body rather than
 * truncating it, and the client that built the body is the only thing that can
 * split it. When the two were in different packages the client did not split
 * at all: `crosscheck pin --sweep` was refused outright, recorded nothing, and
 * named no remedy, from 101 two-file pins upward.
 */
export const MAX_PIN_SWEEP_UPDATES = 200;

/**
 * The one path shape a recorded touch can have. `toRepoRelative`
 * (connector-core capture/target-paths.ts) is the only minter of a target
 * value, and it emits POSIX-separated, repo-relative paths with no leading
 * slash and no `..` — a pin carrying anything else could never intersect a
 * touch, so it would watch NOTHING while reading as registered in `status`.
 * That is the fail-silent-dead shape constraint 4 forbids, so it is a parse
 * error instead.
 */
const REPO_RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\\]+$/;

const pinId = z
  .string()
  .min(1)
  .max(MAX_RECORD_ID_LENGTH)
  .regex(SAFE_ID_PATTERN, "id carries characters an id may not carry");

const pinPath = z
  .string()
  .min(1)
  .max(MAX_PIN_PATH_CHARS)
  .regex(REPO_RELATIVE_PATH, "path is not repo-relative POSIX");

const PinShapeSchema = z.object({
  id: pinId,
  repo: z.string().min(1),
  surface: z.string().min(1).max(MAX_PIN_SURFACE_CHARS),
  files: z.array(pinPath).min(1).max(MAX_PIN_FILES),
  /**
   * Optional ONLY above the speaking cap (the refinement below). Nick's
   * decision, verbatim: mandatory for speaking pins, optional for
   * briefing-only ones. A pin nobody can falsify in 30 seconds is an
   * assertion, not a reference.
   */
  check: z.string().min(1).max(MAX_PIN_CHECK_CHARS).optional(),
  /**
   * EVIDENCE, not a verdict (PIN_PRESENCE_TERMINAL). The hub stamps the
   * stored capture mode from it; a body that omits it or names anything else
   * fails CLOSED here, before anything reaches the database.
   */
  presence: z.literal(PIN_PRESENCE_TERMINAL),
  /** Drift is rendered against this ("verified at abc1234; your base is …"). */
  verifiedAtCommit: z.string().min(1).max(MAX_RECORD_ID_LENGTH),
});

export const PinSchema = PinShapeSchema.superRefine((pin, ctx) => {
  if (pin.files.length <= MAX_SPEAKING_PIN_FILES && pin.check === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["check"],
      message: `a pin of ${String(MAX_SPEAKING_PIN_FILES)} files or fewer may speak, so it needs a check recipe the reader can run in 30 seconds`,
    });
  }
});

export type Pin = z.infer<typeof PinSchema>;

/**
 * Message-eligible: small enough to name one surface AND falsifiable on the
 * spot. Both halves, because either alone lets an unfalsifiable sentence
 * reach a session under somebody's name. Stage 1 never speaks — this is what
 * `status` counts and what Stage 2's notice lane will gate on.
 */
export const isSpeakingPin = (pin: {
  readonly files: readonly string[];
  readonly check?: string | undefined;
}): boolean =>
  pin.files.length <= MAX_SPEAKING_PIN_FILES &&
  pin.check !== undefined &&
  pin.check.length > 0;

/**
 * WHO MAY PIN — a TEAM setting, not baked-in behaviour. "anyone" is the
 * shipped default: at n=3 social visibility beats permission machinery, and
 * every pin carries its author's name in `status`. At n=30 that default rots
 * — pins on code the pinner has never opened, with no findable owner — so
 * "touched_files" restricts pinning to files your own sessions have actually
 * touched inside the suspect window, which the hub can check from data it
 * already holds. Neither value blocks anything else a person does.
 */
export const TEAM_PIN_POLICIES = ["anyone", "touched_files"] as const;

export type TeamPinPolicy = (typeof TEAM_PIN_POLICIES)[number];

/**
 * WHETHER `crosscheck suspect` NAMES SESSIONS — a TEAM setting for the same
 * reason. "sessions" is the shipped default and is what makes the answer
 * useful. It is switchable because in Germany tooling from which individual
 * performance or behaviour data can be derived is mitbestimmungspflichtig
 * (works council) and engages the GDPR; a team under that regime should be
 * able to turn attribution off without uninstalling the product.
 * "counts_only" answers with the counts and no rows.
 */
export const TEAM_SUSPECT_ATTRIBUTIONS = ["sessions", "counts_only"] as const;

export type TeamSuspectAttribution = (typeof TEAM_SUSPECT_ATTRIBUTIONS)[number];
