/**
 * WHAT ONE POINTER STANDS AT, read and written under one lock (1.0 spec 07
 * §13.11, review H2).
 *
 * One pointer in one session is one intervention (review M4): every outcome
 * and every noise label on any of its deliveries speaks for all of them. The
 * outcome write and the person's noise label both decide "what stood, what
 * stands now" from the same rows, so both take the pointer's delivery rows
 * FOR UPDATE inside their transaction — a label landing mid-write waits, and
 * no answer is computed from a state that changed under it.
 *
 * ORDER IS (timestamp, id), AND NO TWO WORDS SHARE AN INSTANT. A word on a
 * pointer is stamped strictly after the pointer's newest word of any kind, so
 * two words in one millisecond are never a coin toss between rows with equal
 * timestamps: the later one stands. The label wins a tie with an outcome (D-O7).
 *
 * EVERY WORD READ HERE IS THE PERSON'S (human provenance, 0.11). 07 §13.12
 * ranked the person's word above their agent's by the route each arrived on.
 * Since 0.11 a word reaches these tables only through the person's passkey
 * confirmation, always as the person's (J8), and a pre-0.11 row is read by no
 * standing (`isConfirmedRow`): the agent's word is a DRAFT until the person
 * makes it theirs, so the agent channel the ranking guarded can no longer
 * occur here, and its branch is retired (review M1).
 */
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { HintOutcome } from "@crosscheck/schema";

import { NOISE_WORDS } from "./pilot-label-figures.ts";
import { isConfirmedRow } from "./human-provenance.ts";
import type { DbExecutor } from "../db/client.ts";

/** One pointer in one session — one intervention. */
export interface Pointer {
  readonly sessionId: string;
  readonly refId: string;
}

/**
 * What a pointer can stand at once something was said: an outcome, or one of
 * the person's labels — noise, or helpful (round-5 LOW-4: a verdict of the
 * person's, never overturned by an agent's word either).
 */
export type StandingWord = HintOutcome | "noise" | "helpful";

/** The person's newest label on the pointer, and which word it is. */
export interface LatestLabel {
  readonly word: "noise" | "helpful";
  readonly createdAt: Date;
}

export interface LatestOutcome {
  readonly outcome: HintOutcome;
  readonly reason: string | null;
  readonly createdAt: Date;
}

export interface LatestNoise {
  readonly id: string;
  readonly createdAt: Date;
}

const ofPointer = (alias: string, pointer: Pointer): SQL =>
  sql`${sql.raw(alias)}.session_id = ${pointer.sessionId} AND ${sql.raw(alias)}.ref_id = ${pointer.refId}`;

/**
 * Locks every delivery row of the pointer until the transaction ends — in id
 * order, so two writers on one pointer queue instead of deadlocking (review
 * LOW). PGlite has one connection, so no second writer can be staged to wait
 * on it: the lock is pinned by the SQL it issues (survivor R11), not by a race.
 */
export const lockPointer = async (tx: DbExecutor, pointer: Pointer): Promise<void> => {
  await tx.execute(sql`SELECT d.id FROM hint_deliveries d WHERE ${ofPointer("d", pointer)} ORDER BY d.id FOR UPDATE`);
};

/** The session and ref of a delivery, or undefined when there is none. */
export const pointerOfDelivery = async (tx: DbExecutor, deliveryId: string): Promise<Pointer | undefined> => {
  const rows = await tx.execute<{ session_id: string; ref_id: string }>(sql`
    SELECT session_id, ref_id FROM hint_deliveries WHERE id = ${deliveryId}`);
  const row = rows.rows[0];
  return row === undefined ? undefined : { sessionId: row.session_id, refId: row.ref_id };
};

type OutcomeRow = { readonly outcome: HintOutcome; readonly reason: string | null; readonly at: string | Date };

/** The person's newest confirmed outcome on the pointer. */
export const readPointerOutcome = async (
  tx: DbExecutor,
  pointer: Pointer,
  recipient: string,
): Promise<LatestOutcome | undefined> => {
  const rows = await tx.execute<OutcomeRow>(sql`
    SELECT o.outcome, o.reason, o.created_at AS at FROM hint_outcomes o
    JOIN hint_deliveries d ON d.id = o.delivery_id
    WHERE ${ofPointer("d", pointer)} AND o.recorded_by = ${recipient} AND ${isConfirmedRow("o")}
    ORDER BY o.created_at DESC, o.id DESC LIMIT 1`);
  const row = rows.rows[0];
  return row === undefined ? undefined : { outcome: row.outcome, reason: row.reason, createdAt: new Date(row.at) };
};

/** Everything a recipient said about one pointer: their newest outcome, and their labels. */
export interface PointerWords {
  readonly person: LatestOutcome | undefined;
  readonly noise: LatestNoise | undefined;
  readonly helpful: LatestNoise | undefined;
}

export const readPointerWords = async (tx: DbExecutor, pointer: Pointer, recipient: string): Promise<PointerWords> => ({
  person: await readPointerOutcome(tx, pointer, recipient),
  noise: await readPointerNoise(tx, pointer, recipient),
  helpful: await readPointerHelpful(tx, pointer, recipient),
});

/** The newest instant any word on the pointer carries — the next word is stamped strictly after it. */
export const newestInstant = (words: PointerWords): Date | undefined =>
  [words.person?.createdAt, words.noise?.createdAt, words.helpful?.createdAt]
    .filter((at): at is Date => at !== undefined)
    .reduce<Date | undefined>((newest, at) => (newest === undefined || at.getTime() > newest.getTime() ? at : newest), undefined);

type NoiseRow = { readonly id: string; readonly at: string | Date };

/**
 * The recipient's newest noise on the pointer — the one noise concept (07
 * §13.2): their label, or a later re-assertion of it (review H-B), which is a
 * row of its own because a label's instant never moves.
 */
export const readPointerNoise = async (
  tx: DbExecutor,
  pointer: Pointer,
  recipient: string,
): Promise<LatestNoise | undefined> => {
  const rows = await tx.execute<NoiseRow>(sql`
    SELECT id, at FROM (
      SELECT m.id, m.created_at AS at FROM pilot_marks m
      JOIN hint_deliveries d ON d.id = m.ref_id
      WHERE m.ref_kind = 'hint_delivery' AND ${ofPointer("d", pointer)}
        AND m.marked_by = ${recipient} AND m.mark IN ${NOISE_WORDS} AND ${isConfirmedRow("m")}
      UNION ALL
      SELECT r.id, r.created_at AS at FROM noise_reassertions r
      JOIN hint_deliveries rd ON rd.id = r.delivery_id
      WHERE ${ofPointer("rd", pointer)} AND r.marked_by = ${recipient} AND ${isConfirmedRow("r")}
    ) noise
    ORDER BY at DESC, id DESC LIMIT 1`);
  const row = rows.rows[0];
  return row === undefined ? undefined : { id: row.id, createdAt: new Date(row.at) };
};

/**
 * The recipient's newest helpful label on the pointer (round-5 LOW-4). One
 * label per person and delivery, so a helpful said twins apart is the newest.
 */
export const readPointerHelpful = async (
  tx: DbExecutor,
  pointer: Pointer,
  recipient: string,
): Promise<LatestNoise | undefined> => {
  const rows = await tx.execute<NoiseRow>(sql`
    SELECT m.id, m.created_at AS at FROM pilot_marks m
    JOIN hint_deliveries d ON d.id = m.ref_id
    WHERE m.ref_kind = 'hint_delivery' AND ${ofPointer("d", pointer)}
      AND m.marked_by = ${recipient} AND m.mark = 'helpful' AND ${isConfirmedRow("m")}
    ORDER BY m.created_at DESC, m.id DESC LIMIT 1`);
  const row = rows.rows[0];
  return row === undefined ? undefined : { id: row.id, createdAt: new Date(row.at) };
};

/** The person's newest label of either word — noise or helpful — or undefined when they gave none. */
export const newestLabel = (words: PointerWords): LatestLabel | undefined => {
  const noise = words.noise === undefined ? undefined : { word: "noise" as const, createdAt: words.noise.createdAt };
  const helpful = words.helpful === undefined ? undefined : { word: "helpful" as const, createdAt: words.helpful.createdAt };
  if (noise === undefined || helpful === undefined) {
    return noise ?? helpful;
  }
  return helpful.createdAt.getTime() > noise.createdAt.getTime() ? helpful : noise;
};

/** Of the person's outcome and their newest label: the later one, the label on a tie (D-O7). */
export const standingOf = (
  latest: LatestOutcome | undefined,
  label: LatestLabel | undefined,
): StandingWord | null => {
  if (label !== undefined && (latest === undefined || label.createdAt.getTime() >= latest.createdAt.getTime())) {
    return label.word;
  }
  return latest?.outcome ?? null;
};

/**
 * The person's own word on the OUTCOME axis (07 §13.14, round-6 HIGH-1): their
 * outcome, or their noise while noise is their newest label — a newer helpful
 * cancels an older noise (a). Helpful itself is a verdict on the LABEL axis
 * and never competes with the person's own outcome, in either order.
 */
export const personsOutcomeStanding = (words: PointerWords): StandingWord | null => {
  const label = newestLabel(words);
  return standingOf(words.person, label?.word === "noise" ? label : undefined);
};

/**
 * WHAT STANDS (07 §13.14): the person's own word on the outcome axis. Since
 * 0.11 every word here is the person's (see the header), so 07 §13.12's
 * fallback to the agent's newest word, and the helpful label's veto of it, are
 * retired with the channel they ranked (review M1).
 */
export const standingOfWords = (words: PointerWords): StandingWord | null => personsOutcomeStanding(words);

/** One millisecond — the smallest step the hub's clock and the stored instants share. */
const NEXT_INSTANT_MS = 1;

/** Now, or just after `after` when now would not be later than it — never an instant a word already has. */
export const instantAfter = (now: Date, after: Date | undefined): Date =>
  after === undefined || now.getTime() > after.getTime() ? now : new Date(after.getTime() + NEXT_INSTANT_MS);
