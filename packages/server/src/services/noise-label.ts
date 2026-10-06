/**
 * THE PERSON'S NOISE LABEL ON A POINTER (1.0 spec 07 §13.11, review H2).
 *
 * The label is the person's verdict, and an outcome is somebody's word about
 * what the hint led to; per pointer the later of the two stands. Since an
 * agent's NEW word may stand over the label, the person must always be able to
 * say noise again — and `pilot_marks` keeps one row per person and delivery,
 * so saying it again over a later word RESTAMPS the label rather than being
 * swallowed as a repeat. Said again while it already stands, it is a repeat.
 *
 * Decided under the pointer's lock, like the outcome write, and the answer
 * says what stands now and what stood before.
 */
import { and, eq } from "drizzle-orm";
import { PILOT_LEGACY_NOISE_MARK } from "@crosscheck/schema";

import { pilotMarks } from "../db/schema.ts";
import {
  lockPointer,
  pointerOfDelivery,
  readPointerNoise,
  readPointerOutcome,
  standingOf,
} from "./pointer-standing.ts";
import type { LatestOutcome, StandingWord } from "./pointer-standing.ts";
import type { Db, DbExecutor } from "../db/client.ts";
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

const NOISE_LABELS: readonly string[] = ["noise", PILOT_LEGACY_NOISE_MARK];

/** A label wins a tie (D-O7): now, or the newest word's own instant when that is later, stands. */
const labelInstant = (now: Date, latest: LatestOutcome | undefined): Date =>
  latest !== undefined && latest.createdAt.getTime() > now.getTime() ? latest.createdAt : now;

const readOwnMark = async (
  tx: DbExecutor,
  deliveryId: string,
  markedBy: string,
): Promise<{ readonly id: string; readonly mark: string } | undefined> => {
  const rows = await tx
    .select({ id: pilotMarks.id, mark: pilotMarks.mark })
    .from(pilotMarks)
    .where(
      and(eq(pilotMarks.refKind, "hint_delivery"), eq(pilotMarks.refId, deliveryId), eq(pilotMarks.markedBy, markedBy)),
    )
    .limit(1);
  return rows[0];
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
    const at = labelInstant(deps.now(), latest);
    const inserted = await tx
      .insert(pilotMarks)
      .values(row(`pm_${crypto.randomUUID()}`, at))
      .onConflictDoNothing()
      .returning({ id: pilotMarks.id });
    if (inserted[0] !== undefined) {
      return { id: inserted[0].id, repeated: false, stands: "noise", replaced: before };
    }
    const own = await readOwnMark(tx, deliveryId, markedBy);
    if (own === undefined || !NOISE_LABELS.includes(own.mark) || before === "noise") {
      return { id: deliveryId, repeated: true, stands: before, replaced: null };
    }
    await tx.update(pilotMarks).set({ createdAt: at }).where(eq(pilotMarks.id, own.id));
    return { id: own.id, repeated: false, stands: "noise", replaced: before };
  });
