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
