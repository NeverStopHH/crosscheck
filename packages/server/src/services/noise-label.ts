/**
 * THE PERSON'S NOISE LABEL ON A POINTER (1.0 spec 07 §13.11, reviews H2, H-B).
 *
 * The label is the person's verdict, and an outcome is somebody's word about
 * what the hint led to. The person must always be able to say noise again —
 * and `pilot_marks` keeps one label per person and delivery, the first being
 * what precision counts. So saying noise again over a word recorded since is
 * a NEW ROW in `noise_reassertions`, with its own sentence: APPEND-ONLY, never
 * a restamped label, because an instant that moves would move every closed
 * month that already read it (review H-B). Said while noise already stands,
 * it is a repeat and writes nothing.
 *
 * Decided under the pointer's lock, like the outcome write, stamped strictly
 * after the pointer's newest word of any kind, and the answer says what
 * stands now and what stood before.
 */
import { sql } from "drizzle-orm";

import { pilotMarks, noiseReassertions } from "../db/schema.ts";
import { isConfirmedRow } from "./human-provenance.ts";
import {
  instantAfter,
  lockPointer,
  newestInstant,
  pointerOfDelivery,
  readPointerWords,
  standingOfWords,
} from "./pointer-standing.ts";
import type { PointerWords, StandingWord } from "./pointer-standing.ts";
import type { DbExecutor } from "../db/client.ts";
import type { Clock } from "../types.ts";

/** Possibly the confirmation's open transaction (human provenance §6): this one then nests as a savepoint. */
interface Deps {
  readonly db: DbExecutor;
  readonly now: Clock;
}

export type MarkRow = typeof pilotMarks.$inferInsert;

export interface NoiseLabelOutcome {
  readonly id: string;
  readonly repeated: boolean;
  /** What the pointer stands at for the person once this was said. */
  readonly stands: StandingWord | null;
  /** What stood before — an outcome the label now stands over, the label itself, or nothing. */
  readonly replaced: StandingWord | null;
}

const NO_WORDS: PointerWords = { person: undefined, noise: undefined, helpful: undefined };

/**
 * WHETHER THE PERSON ALREADY HAS A LABEL IN EFFECT ON `refId` — the one label
 * per person per delivery that precision counts. A label whose confirmation
 * was retracted (compromised) or never stood (its passkey revoked in the
 * cool-off) holds no place (round-2 R2-M1): the database keeps one row per
 * confirmation, and this is the rule.
 */
export const labelInEffect = async (
  db: DbExecutor,
  input: { readonly refKind: string; readonly refId: string; readonly markedBy: string },
): Promise<boolean> => {
  const rows = await db.execute(sql`
    SELECT 1 FROM pilot_marks m
    WHERE m.ref_kind = ${input.refKind} AND m.ref_id = ${input.refId} AND m.marked_by = ${input.markedBy}
      AND ${isConfirmedRow("m")}
    LIMIT 1`);
  return rows.rows.length > 0;
};

export const writeNoiseOnPointer = (
  deps: Deps,
  deliveryId: string,
  markedBy: string,
  row: (id: string, createdAt: Date) => MarkRow,
): Promise<NoiseLabelOutcome> =>
  deps.db.transaction(async (tx) => {
    const pointer = await pointerOfDelivery(tx, deliveryId);
    if (pointer !== undefined) {
      await lockPointer(tx, pointer);
    }
    const words = pointer === undefined ? NO_WORDS : await readPointerWords(tx, pointer, markedBy);
    // The person's label outranks every agent word (07 §13.12): noise stands over those already.
    const before = standingOfWords(words);
    const at = instantAfter(deps.now(), newestInstant(words));
    const label = row(`pm_${crypto.randomUUID()}`, at);
    const holdsPlace = await labelInEffect(tx, { refKind: label.refKind, refId: label.refId, markedBy });
    const inserted = holdsPlace
      ? []
      : await tx.insert(pilotMarks).values(label).onConflictDoNothing().returning({ id: pilotMarks.id });
    if (inserted[0] !== undefined) {
      return { id: inserted[0].id, repeated: false, stands: "noise", replaced: before };
    }
    if (before === "noise") {
      return { id: deliveryId, repeated: true, stands: before, replaced: null };
    }
    // The person's own later word — a new row beside the label, with its sentence.
    const id = `nr_${crypto.randomUUID()}`;
    await tx.insert(noiseReassertions).values({
      id,
      repo: label.repo,
      deliveryId,
      markedBy,
      reason: label.reason ?? null,
      createdAt: at,
      // The same confirmation as the label it re-asserts (human provenance §4).
      provenance: label.provenance,
      confirmationId: label.confirmationId ?? null,
      confirmationPosition: label.confirmationPosition ?? null,
    });
    return { id, repeated: false, stands: "noise", replaced: before };
  });
