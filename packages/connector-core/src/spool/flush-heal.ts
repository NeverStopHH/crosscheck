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
 * life — the refused batch's ones are counted `rejected / session_ended`, what
 * the hub answered for them — and the stragglers of a refused life are
 * withheld from every later delivery (spool/refused-lives.ts), counted under
 * their own reason, `withheld`, because they were never sent.
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
import { isTaken } from "./owed-work-context.ts";
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
  | ({
      readonly outcome: "healed";
      /** The life's work context, when the walk registered it: sent ahead of a re-send. */
      readonly workContext?: Record<string, unknown>;
    } & SessionHeal)
  | { readonly outcome: "pending" }
  | { readonly outcome: "failed" };

/**
 * Registers the refused session's next life before `deadlineMs`. `beforeWalk`
 * runs once the walk is certain to start, before its first register — the
 * moment a caller writes down what it has already lost, so the register
 * carries it (flows/heal-session.ts).
 */
export interface SessionHealer {
  (refusal: SessionRefusal, deadlineMs: number, beforeWalk?: () => Promise<void>): Promise<HealResult>;
  /**
   * True while this host session's last walk, for `sessionId`, registered
   * nothing and its cooldown runs: every record sent under that life is
   * refused again, so a flush sends none until the next walk may run
   * (review-2 LOW-5).
   */
  readonly refusedFor?: (sessionId: string) => Promise<boolean>;
}

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
 * The first answer with the re-sent records' answers in their places — the
 * re-send's first `ahead` answers are for records sent before them. A hub
 * that sends no per-record results the second time leaves the first answer
 * standing — counted as refused, the direction a loss may err in.
 */
const merged = (
  first: IngestSummary,
  resent: readonly number[],
  again: IngestSummary,
  ahead: number,
): IngestSummary => {
  const byIndex = new Map(resent.map((index, position) => [index, again.results?.[ahead + position]]));
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
  /** Indices of refusals already written to the drop ledger before the walk. */
  readonly counted: ReadonlySet<number>;
}

const NONE_COUNTED: ReadonlySet<number> = new Set();

export interface HealInput {
  readonly ctx: HubContext;
  readonly developerId: string | null;
  readonly flusherSessionId: string;
  /** The batch as SPOOLED, aligned with the indices `first.results` carries. */
  readonly spooled: readonly Record<string, unknown>[];
  readonly first: IngestSummary;
  readonly healer: SessionHealer | undefined;
  readonly deadlineMs: number;
  /**
   * The caller's certain losses, written before a walk's register — its own,
   * and the `sealed` refusals (indices into `spooled`) no heal can carry
   * (spool/batch-losses.ts).
   */
  readonly beforeWalk?: (sealed: readonly number[]) => Promise<void>;
  /** Settles the work context a heal owes once the hub took it (spool/owed-work-context.ts). */
  readonly settleOwed?: (record: Record<string, unknown>) => Promise<void>;
}

/**
 * The refusals no heal can carry: records the refused life produced whose body
 * names it, when the hub said that life ENDED. Never re-sent (`mayResend`), so
 * their loss is certain before the walk starts.
 */
const sealedRefusals = (input: HealInput, refusals: readonly RecordResult[], cause: RefusalCause): readonly number[] =>
  cause !== "session_ended"
    ? []
    : refusals
        .map((result) => result.index)
        .filter((index) => {
          const record = input.spooled[index];
          return (
            record !== undefined &&
            bodyNamesItsSession(record["kind"]) &&
            writtenBy(record) === input.flusherSessionId
          );
        });

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
 * Whether the refusal fell on the flusher's OWN work context while the hub has
 * never registered the flusher (review-2 finding 1). That life may still be
 * registered as itself, and every later record of it names this one: spent
 * now, the heal that registers the life finds its work context gone, and
 * every edit after it is refused. A life the hub ENDED is never registered
 * again — its heal moves on and spools the next life's — so its own is
 * spent as before.
 */
const spendsOwnWorkContext = (
  input: HealInput,
  refusals: readonly RecordResult[],
  cause: RefusalCause,
): boolean =>
  cause === "session_unknown" &&
  refusals.some((result) => {
    const record = input.spooled[result.index];
    return record?.["kind"] === "work_context" && writtenBy(record) === input.flusherSessionId;
  });

/**
 * Null when the batch must stay on disk: a re-send was owed and could not be
 * made — no room left, or the hub did not take the request — or no life was
 * healed and the refusal fell on records a later heal needs: ANOTHER
 * conversation's, or the unregistered flusher's own work context. One
 * conversation's dead session never spends another conversation's records
 * (review P7): they wait for a live flusher — that conversation's own, or this
 * one once it heals — and the hub deduplicates whatever was already accepted.
 */
export const healAndResend = async (input: HealInput): Promise<HealedDelivery | null> => {
  const refusals = (input.first.results ?? []).filter(isOwnSessionRefusal);
  if (refusals.length === 0) {
    return { summary: input.first, heal: null, asked: false, counted: NONE_COUNTED };
  }
  const cause = refusalCauseOf(refusals[0] ?? { index: 0, status: "rejected" });
  const neededLater =
    spendsAnotherConversation(input, refusals) || spendsOwnWorkContext(input, refusals, cause);
  if (input.healer === undefined) {
    return neededLater ? null : { summary: input.first, heal: null, asked: false, counted: NONE_COUNTED };
  }
  const sealed = sealedRefusals(input, refusals, cause);
  // BEFORE THE WALK'S REGISTER, so the next life reports what this refusal
  // cost from its first word and coverage never reads the window complete in
  // between (review P3). Only a walk that starts runs this.
  let walked = false;
  const result = await input.healer({ sessionId: input.flusherSessionId, cause }, input.deadlineMs, async () => {
    await input.beforeWalk?.(sealed);
    walked = true;
  });
  const counted: ReadonlySet<number> = walked ? new Set(sealed) : NONE_COUNTED;
  // A walk in flight, or no room for one: what this batch holds may still go
  // under the life that walk lands, so nothing is spent now (review P5, P6).
  if (result.outcome === "pending") {
    return null;
  }
  if (result.outcome === "failed") {
    return neededLater ? null : { summary: input.first, heal: null, asked: true, counted };
  }
  const heal: SessionHeal = { refusedSessionId: result.refusedSessionId, sessionId: result.sessionId };
  const resent = refusals
    .map((result) => result.index)
    .filter((index) => {
      const record = input.spooled[index];
      return record !== undefined && mayResend(record, heal);
    });
  // NOTHING TO RE-SEND: the batch was the refused life's own records. The
  // life the heal registered still owes its work context, and the drain pays
  // it next — alone, when no record of that life is left to carry it
  // (spool/flush.ts, review-2 round 7).
  if (resent.length === 0) {
    return { summary: input.first, heal, asked: true, counted };
  }
  // No room left to re-send after a walk: the batch waits for the next flush,
  // which sends it under the healed life. What the walk already wrote down is
  // noted on the cursor, and that flush does not count it again.
  const roomMs = input.deadlineMs - Date.now();
  if (roomMs <= 0) {
    return null;
  }
  // THE LIFE'S WORK CONTEXT GOES FIRST (review-2 MEDIUM-1): every record
  // re-sent here names it. It is the debt the heal wrote down; this re-send
  // pays it when it lands, and when it does not — a 503, a timeout — the debt
  // waits for the next batch that carries the life's records (review-2 round
  // 6, HIGH-1), and so does this batch. A batch is one short of the hub's
  // limit (spool/flush.ts), so the two always fit.
  const ahead = result.workContext === undefined
    ? []
    : [withProducer(result.workContext, input.developerId, heal.sessionId)];
  const again = await postRecords(
    { ...input.ctx, timeoutMs: Math.min(input.ctx.timeoutMs, roomMs) },
    [
      ...ahead,
      ...resent.map((index) => withProducer(input.spooled[index] ?? {}, input.developerId, heal.sessionId)),
    ],
  );
  if (!again.ok) {
    return null;
  }
  if (result.workContext !== undefined && isTaken(again.data.results?.find((answer) => answer.index === 0))) {
    await input.settleOwed?.(result.workContext);
  }
  return { summary: merged(input.first, resent, again.data, ahead.length), heal, asked: true, counted };
};
