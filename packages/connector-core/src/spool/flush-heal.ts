/**
 * WHAT A FLUSH DOES WHEN THE HUB REFUSES ITS OWN SESSION (flows/heal-session.ts).
 *
 * `flushOneBatch` stamps every record with the FLUSHING session, so a batch
 * refused with `session_ended` or `session_unknown` is the hub saying the
 * flusher itself is dead to it — not the session a body names, which may be
 * ended (records.ts checkProducerSession). Before this, the refusal was counted
 * and the cursor moved on; now the flush asks its healer once, and when a life
 * is registered it re-sends what that batch may honestly carry under it.
 *
 * THE ONE THING A RE-SEND MUST NOT DO is file a record into the refused life
 * after the hub ended it. A kind whose body names its session (target, claim,
 * claim_edge, work_context) is positioned by the hub in THAT session, whoever
 * delivers it — so a record the refused life produced would land in an ended
 * session past its end, or under an epoch that session never had, and break
 * an order that was fine (spec 01 §3.4). Those are never re-sent under another
 * life, and the stragglers of a refused life are withheld from every later
 * delivery (spool/refused-lives.ts); both are counted as `rejected` with the
 * cause `session_ended`, which is what the hub answered for them.
 *
 * Everything else re-sends: a kind the hub files under the PRODUCER loses its
 * position on the way (capture/records.ts withProducer — a foreign delivery is
 * unsequenced, never misplaced), and another session's backlog goes where its
 * body says, exactly as any successor flush delivers it. A session the hub
 * never registered and the healer registered AS ITSELF re-sends everything
 * unchanged: same producer, same session, same epoch.
 */
import { bodyNamesItsSession, withProducer } from "../capture/records.ts";
import { postRecords } from "../http/hub.ts";
import type { IngestSummary, RecordResult } from "../http/hub.ts";
import type { HubContext } from "../http/client.ts";
import { addCount } from "./counts.ts";
import type { Counts } from "./counts.ts";
import { conversationOf } from "../state/session-lineage.ts";
import { rejectCauseOf } from "./reject-cause.ts";
import type { RejectCause } from "./reject-cause.ts";

/** A heal that registered a life: the id the hub refused, and the one it took. */
export interface SessionHeal {
  readonly refusedSessionId: string;
  readonly sessionId: string;
}

/** The two refusals a heal answers: the hub ended the session, or never registered it. */
export type RefusalCause = "session_ended" | "session_unknown";

export interface SessionRefusal {
  readonly sessionId: string;
  readonly cause: RefusalCause;
}

/**
 * What a heal answers. `healed`: a life the refused session's records may go
 * under — one the walk registered, or one a sibling already moved the state to.
 * `pending`: no walk now, but one may still land — a sibling's is in flight,
 * or there was no room for a round trip — so a caller keeps what it holds.
 * `failed`: the walk ran and registered nothing, or one did within the
 * cooldown; the refusal stands.
 */
export type HealResult =
  | ({ readonly outcome: "healed" } & SessionHeal)
  | { readonly outcome: "pending" }
  | { readonly outcome: "failed" };

/**
 * Registers the refused session's next life before `deadlineMs`. `beforeWalk`
 * runs once the walk is certain to start, before its first register — the
 * moment a caller writes down what it has already lost, so the register
 * carries it (flows/heal-session.ts).
 */
export type SessionHealer = (
  refusal: SessionRefusal,
  deadlineMs: number,
  beforeWalk?: () => Promise<void>,
) => Promise<HealResult>;

/** The causes that say the PRODUCER is dead to the hub — the flusher, after the stamp. */
const OWN_SESSION_CAUSES: ReadonlySet<RejectCause> = new Set(["session_ended", "session_unknown"]);

/** The refusal behind a batch: every record shares the one producer it names. */
const refusalCauseOf = (result: RecordResult): RefusalCause =>
  rejectCauseOf(result.issues) === "session_unknown" ? "session_unknown" : "session_ended";

export const isOwnSessionRefusal = (result: RecordResult): boolean =>
  result.status === "rejected" && OWN_SESSION_CAUSES.has(rejectCauseOf(result.issues));

/** The session that wrote the record — its envelope's producer as spooled. */
const writtenBy = (record: Record<string, unknown>): unknown =>
  (record["producer"] as { sessionId?: unknown } | undefined)?.sessionId;

/**
 * A record its refused life produced and whose body names that life: never
 * delivered by another session (header). The flusher's own id is excluded —
 * that life is not refused yet, and the hub answers for itself.
 */
export const isRefusedLifeRecord = (
  record: Record<string, unknown>,
  refusedLives: ReadonlySet<string>,
  flusherSessionId: string,
): boolean => {
  const author = writtenBy(record);
  return (
    bodyNamesItsSession(record["kind"]) &&
    typeof author === "string" &&
    author !== flusherSessionId &&
    refusedLives.has(author)
  );
};

const mayResend = (record: Record<string, unknown>, heal: SessionHeal): boolean =>
  heal.sessionId === heal.refusedSessionId ||
  !(bodyNamesItsSession(record["kind"]) && writtenBy(record) === heal.refusedSessionId);

/** The record kinds behind a set of records, for a drop line's `kinds`. */
export const kindsOf = (records: readonly Record<string, unknown>[]): Counts =>
  records.reduce<Counts>((kinds, record) => {
    const kind = record["kind"];
    return typeof kind === "string" ? addCount(kinds, kind, 1) : kinds;
  }, {});

const countOf = (results: readonly RecordResult[], status: string): number =>
  results.filter((result) => result.status === status).length;

/**
 * The first answer with the re-sent records' answers in their places. A hub
 * that sends no per-record results the second time leaves the first answer
 * standing — counted as refused, the direction a loss may err in.
 */
const merged = (
  first: IngestSummary,
  resent: readonly number[],
  again: IngestSummary,
): IngestSummary => {
  const byIndex = new Map(resent.map((index, position) => [index, again.results?.[position]]));
  const results = (first.results ?? []).map((result) => {
    const replacement = byIndex.get(result.index);
    return replacement === undefined ? result : { ...replacement, index: result.index };
  });
  return {
    accepted: countOf(results, "accepted"),
    duplicates: countOf(results, "duplicate"),
    ignored: countOf(results, "ignored"),
    rejected: countOf(results, "rejected"),
    results,
  };
};

export interface HealedDelivery {
  readonly summary: IngestSummary;
  /** The life the batch healed into; later batches go under it. */
  readonly heal: SessionHeal | null;
  /** True once the healer was asked, whatever it answered: once per flush. */
  readonly asked: boolean;
}

export interface HealInput {
  readonly ctx: HubContext;
  readonly developerId: string | null;
  readonly flusherSessionId: string;
  /** The batch as SPOOLED, aligned with the indices `first.results` carries. */
  readonly spooled: readonly Record<string, unknown>[];
  readonly first: IngestSummary;
  readonly healer: SessionHealer | undefined;
  readonly deadlineMs: number;
}

/**
 * Whether the refusal fell on ANOTHER conversation's records: a batch the
 * flusher drained for a successor's sake, refused only because the flusher
 * itself is dead to the hub. A record whose writer cannot be read is counted
 * as the flusher's own — it names no other conversation to protect.
 */
const spendsAnotherConversation = (input: HealInput, refusals: readonly RecordResult[]): boolean =>
  refusals.some((result) => {
    const record = input.spooled[result.index];
    const author = record === undefined ? undefined : writtenBy(record);
    return typeof author === "string" && conversationOf(author) !== conversationOf(input.flusherSessionId);
  });

/**
 * Null when the batch must stay on disk: a re-send was owed and could not be
 * made — no room left, or the hub did not take the request — or the refusal
 * fell on ANOTHER conversation's records and no life was healed to carry them.
 * One conversation's dead session never spends another conversation's records
 * (review P7): they wait for a live flusher — that conversation's own, or this
 * one once it heals — and the hub deduplicates whatever was already accepted.
 */
export const healAndResend = async (input: HealInput): Promise<HealedDelivery | null> => {
  const refusals = (input.first.results ?? []).filter(isOwnSessionRefusal);
  if (refusals.length === 0) {
    return { summary: input.first, heal: null, asked: false };
  }
  const othersAtStake = spendsAnotherConversation(input, refusals);
  if (input.healer === undefined) {
    return othersAtStake ? null : { summary: input.first, heal: null, asked: false };
  }
  const result = await input.healer(
    { sessionId: input.flusherSessionId, cause: refusalCauseOf(refusals[0] ?? { index: 0, status: "rejected" }) },
    input.deadlineMs,
  );
  // A walk in flight, or no room for one: what this batch holds may still go
  // under the life that walk lands, so nothing is spent now (review P5, P6).
  if (result.outcome === "pending") {
    return null;
  }
  if (result.outcome === "failed") {
    return othersAtStake ? null : { summary: input.first, heal: null, asked: true };
  }
  const heal: SessionHeal = { refusedSessionId: result.refusedSessionId, sessionId: result.sessionId };
  const resent = refusals
    .map((result) => result.index)
    .filter((index) => {
      const record = input.spooled[index];
      return record !== undefined && mayResend(record, heal);
    });
  if (resent.length === 0) {
    return { summary: input.first, heal, asked: true };
  }
  const roomMs = input.deadlineMs - Date.now();
  if (roomMs <= 0) {
    return null;
  }
  const again = await postRecords(
    { ...input.ctx, timeoutMs: Math.min(input.ctx.timeoutMs, roomMs) },
    resent.map((index) =>
      withProducer(input.spooled[index] ?? {}, input.developerId, heal.sessionId),
    ),
  );
  return again.ok
    ? { summary: merged(input.first, resent, again.data), heal, asked: true }
    : null;
};
