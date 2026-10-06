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
import { pilotMarks, noiseReassertions } from "../db/schema.ts";
import {
  instantAfter,
  lockPointer,
  pointerOfDelivery,
  readPointerNoise,
  readPointerOutcome,
  standingOf,
} from "./pointer-standing.ts";
import type { StandingWord } from "./pointer-standing.ts";
import type { Db } from "../db/client.ts";
import type { Clock } from "../types.ts";

interface Deps {
  readonly db: Db;
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

const newestOf = (left: Date | undefined, right: Date | undefined): Date | undefined => {
  if (left === undefined || right === undefined) {
    return left ?? right;
  }
  return left.getTime() >= right.getTime() ? left : right;
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
    const latest = pointer === undefined ? undefined : await readPointerOutcome(tx, pointer, markedBy);
    const noise = pointer === undefined ? undefined : await readPointerNoise(tx, pointer, markedBy);
    const before = standingOf(latest, noise);
    const at = instantAfter(deps.now(), newestOf(latest?.createdAt, noise?.createdAt));
    const label = row(`pm_${crypto.randomUUID()}`, at);
    const inserted = await tx.insert(pilotMarks).values(label).onConflictDoNothing().returning({ id: pilotMarks.id });
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
    });
    return { id, repeated: false, stands: "noise", replaced: before };
  });
