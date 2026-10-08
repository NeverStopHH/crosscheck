/**
 * THE ONE DEFINITION OF "A PERSON SAID THIS" (human provenance §3, §5).
 *
 * `human_passkey_confirmed` is the only human class. Every producer of a pilot
 * figure that counts a person's judgement filters with `isHumanRow` — one SQL
 * fragment, so the rule cannot drift between the label figures, the outcome
 * view, the team line, the credit and proof 3 — and every writer of a record
 * that counts takes a `HumanStamp`, which only a confirmed batch can mint
 * with a confirmation id that exists (the foreign key holds it).
 */
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { HUMAN_PROVENANCE } from "@crosscheck/schema";

/** What a confirmation writes on every row it applies: the human class and itself. */
export interface HumanStamp {
  readonly provenance: typeof HUMAN_PROVENANCE;
  readonly confirmationId: string;
}

export const humanStamp = (confirmationId: string): HumanStamp => ({
  provenance: HUMAN_PROVENANCE,
  confirmationId,
});

/**
 * `<alias>.provenance` is the human class — the predicate every figure that
 * counts a person's judgement uses, and nothing else may stand in for it. A
 * legacy row (`unknown_legacy`) is never a person's, whatever it once claimed.
 */
export const isHumanRow = (alias: string): SQL => sql`${sql.raw(alias)}.provenance = ${HUMAN_PROVENANCE}`;

/** The same for a pin's retraction, which carries its own provenance column. */
export const isHumanBreak = (alias: string): SQL => sql`${sql.raw(alias)}.broke_provenance = ${HUMAN_PROVENANCE}`;

/**
 * THE WRITE PATH'S RULE: `<alias>` is a word the person confirmed — what the
 * writers decide "what stood, what stands now" from (services/pointer-
 * standing.ts). Not a figure: a figure counts with `isHumanRow`.
 */
export const isConfirmedRow = (alias: string): SQL => sql`${sql.raw(alias)}.provenance = ${HUMAN_PROVENANCE}`;

/**
 * WHERE A PERSON CAN CONFIRM ANYTHING ON THIS HUB (human provenance §9). A
 * passkey needs a secure origin: an https one serves every member; a hub with
 * only localhost serves the browser on its own machine; with none, nothing
 * can ever be `human_passkey_confirmed` here — and every report says so
 * rather than print an empty human figure as if people had judged nothing.
 */
export type HumanConfirmability = "https" | "hub_machine_only" | "none";

export const confirmabilityOf = (origins: readonly string[]): HumanConfirmability => {
  if (origins.length === 0) {
    return "none";
  }
  return origins.some((origin) => origin.startsWith("https:")) ? "https" : "hub_machine_only";
};

/** The RP ID each configured origin binds a passkey to (04a §7): its hostname. */
export const rpIdsOf = (origins: readonly string[]): readonly string[] => [
  ...new Set(origins.map((origin) => new URL(origin).hostname)),
];
