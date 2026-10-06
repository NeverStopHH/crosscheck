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
 * THE PERSON OUTRANKS THE AGENT (§13.12). A word the person said — at a
 * terminal, `crosscheck noise / helpful / followed / overrode` — is never
 * overturned by their agent's (`mark_hint_outcome`); the hub knows which by
 * the route a word arrived on, never by a claim in its body.
 */
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { HintOutcome, HintOutcomeChannel } from "@crosscheck/schema";

import { NOISE_WORDS } from "./pilot-label-figures.ts";
import type { DbExecutor } from "../db/client.ts";

/** One pointer in one session — one intervention. */
export interface Pointer {
  readonly sessionId: string;
  readonly refId: string;
}

/** What a pointer can stand at once something was said: an outcome, or the person's noise label. */
export type StandingWord = HintOutcome | "noise";

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

/** The person's words, or an agent's — a row from before the channel was stamped is an agent's. */
const ofChannel = (channel: HintOutcomeChannel): SQL =>
  channel === "person" ? sql`o.recorded_via = 'person'` : sql`o.recorded_via IS DISTINCT FROM 'person'`;

export const readPointerOutcome = async (
  tx: DbExecutor,
  pointer: Pointer,
  recipient: string,
  channel: HintOutcomeChannel,
): Promise<LatestOutcome | undefined> => {
  const rows = await tx.execute<OutcomeRow>(sql`
    SELECT o.outcome, o.reason, o.created_at AS at FROM hint_outcomes o
    JOIN hint_deliveries d ON d.id = o.delivery_id
    WHERE ${ofPointer("d", pointer)} AND o.recorded_by = ${recipient} AND ${ofChannel(channel)}
    ORDER BY o.created_at DESC, o.id DESC LIMIT 1`);
  const row = rows.rows[0];
  return row === undefined ? undefined : { outcome: row.outcome, reason: row.reason, createdAt: new Date(row.at) };
};

/** Everything a recipient said about one pointer: their newest own word, their agent's, and their noise. */
export interface PointerWords {
  readonly person: LatestOutcome | undefined;
  readonly agent: LatestOutcome | undefined;
  readonly noise: LatestNoise | undefined;
}

export const readPointerWords = async (tx: DbExecutor, pointer: Pointer, recipient: string): Promise<PointerWords> => ({
  person: await readPointerOutcome(tx, pointer, recipient, "person"),
  agent: await readPointerOutcome(tx, pointer, recipient, "agent"),
  noise: await readPointerNoise(tx, pointer, recipient),
});

/** The newest instant any word on the pointer carries — the next word is stamped strictly after it. */
export const newestInstant = (words: PointerWords): Date | undefined =>
  [words.person?.createdAt, words.agent?.createdAt, words.noise?.createdAt]
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
        AND m.marked_by = ${recipient} AND m.mark IN ${NOISE_WORDS}
      UNION ALL
      SELECT r.id, r.created_at AS at FROM noise_reassertions r
      JOIN hint_deliveries rd ON rd.id = r.delivery_id
      WHERE ${ofPointer("rd", pointer)} AND r.marked_by = ${recipient}
    ) noise
    ORDER BY at DESC, id DESC LIMIT 1`);
  const row = rows.rows[0];
  return row === undefined ? undefined : { id: row.id, createdAt: new Date(row.at) };
};

/** Of an outcome and the person's noise: the later one, the label on a tie (D-O7). */
export const standingOf = (
  latest: LatestOutcome | undefined,
  noise: LatestNoise | undefined,
): StandingWord | null => {
  if (noise !== undefined && (latest === undefined || noise.createdAt.getTime() >= latest.createdAt.getTime())) {
    return "noise";
  }
  return latest?.outcome ?? null;
};

/**
 * WHAT STANDS (07 §13.12): the person's newest word — their own outcome or
 * their noise — whenever they said anything; only otherwise the agent's
 * newest. An agent's word is recorded but never overturns the person's; only
 * the person's own later word changes it.
 */
export const standingOfWords = (words: PointerWords): StandingWord | null =>
  standingOf(words.person, words.noise) ?? words.agent?.outcome ?? null;

/** One millisecond — the smallest step the hub's clock and the stored instants share. */
const NEXT_INSTANT_MS = 1;

/** Now, or just after `after` when now would not be later than it — never an instant a word already has. */
export const instantAfter = (now: Date, after: Date | undefined): Date =>
  after === undefined || now.getTime() > after.getTime() ? now : new Date(after.getTime() + NEXT_INSTANT_MS);
