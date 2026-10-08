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

/**
 * What a confirmation writes on every row it applies: the human class, itself,
 * and the position of the ITEM that signed this row (review M5/P9) — the
 * database holds the row to that item by a composite foreign key.
 */
export interface HumanStamp {
  readonly provenance: typeof HUMAN_PROVENANCE;
  readonly confirmationId: string;
  readonly confirmationPosition: number;
}

export const humanStamp = (confirmationId: string, confirmationPosition: number): HumanStamp => ({
  provenance: HUMAN_PROVENANCE,
  confirmationId,
  confirmationPosition,
});

/**
 * THE PASSKEY THAT SIGNED `<confirmation>` (review H1, the owner's decision):
 * unrevoked always, and — for a figure — past its announced cool-off at `at`.
 * A fresh passkey's confirmation takes effect at once (Q19) but counts only
 * from its usable instant; revoking the passkey retracts everything it signed.
 */
const signerStands = (confirmationColumn: string, at: Date | null): SQL => sql`EXISTS (
  SELECT 1 FROM human_confirmations hc JOIN passkeys p ON p.credential_id = hc.credential_id
  WHERE hc.id = ${sql.raw(confirmationColumn)} AND p.revoked_at IS NULL
    ${at === null ? sql`` : sql`AND p.usable_from <= ${at.toISOString()}::timestamptz`})`;

/**
 * `<alias>` COUNTS AS A PERSON'S JUDGEMENT at `at` — the predicate every figure
 * uses, and nothing else may stand in for it: the human class, signed by a
 * passkey that is unrevoked and past its cool-off. A legacy row
 * (`unknown_legacy`) is never a person's, whatever it once claimed.
 */
export const isHumanRow = (alias: string, at: Date): SQL =>
  sql`(${sql.raw(alias)}.provenance = ${HUMAN_PROVENANCE} AND ${signerStands(`${alias}.confirmation_id`, at)})`;

/** The same for a pin's retraction, which carries its own provenance and confirmation. */
export const isHumanBreak = (alias: string, at: Date): SQL =>
  sql`(${sql.raw(alias)}.broke_provenance = ${HUMAN_PROVENANCE} AND ${signerStands(`${alias}.broke_confirmation_id`, at)})`;

/**
 * THE WRITE PATH'S RULE: `<alias>` is a word the person confirmed with a
 * passkey not since revoked — what the writers decide "what stood, what stands
 * now" from (services/pointer-standing.ts). A confirmation still in its
 * passkey's cool-off already stands here (it took effect, Q19); it counts in
 * a figure only later (`isHumanRow`).
 */
export const isConfirmedRow = (alias: string): SQL =>
  sql`(${sql.raw(alias)}.provenance = ${HUMAN_PROVENANCE} AND ${signerStands(`${alias}.confirmation_id`, null)})`;

/** Confirmed, its passkey unrevoked but still cooling off at `at`: counts from the passkey's usable instant. */
export const isCoolingRow = (alias: string, at: Date): SQL =>
  sql`(${isConfirmedRow(alias)} AND NOT ${signerStands(`${alias}.confirmation_id`, at)})`;

/** Confirmed by a passkey since revoked: retracted from every figure, the row kept. */
export const isRetractedRow = (alias: string): SQL =>
  sql`(${sql.raw(alias)}.provenance = ${HUMAN_PROVENANCE} AND NOT ${signerStands(`${alias}.confirmation_id`, null)})`;

/** When `<alias>`'s confirmation starts counting: its passkey's usable instant. */
export const countingFromOf = (alias: string): SQL => sql`(
  SELECT p.usable_from FROM human_confirmations hc JOIN passkeys p ON p.credential_id = hc.credential_id
  WHERE hc.id = ${sql.raw(alias)}.confirmation_id)`;

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
