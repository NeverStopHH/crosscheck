/**
 * THE WORK CONTEXT A HEAL OWES THE HUB, PERSISTED UNTIL THE HUB TAKES IT
 * (review-2 round 6, HIGH-1).
 *
 * A heal that registers a life — the same id or the next — owes the hub that
 * life's work context: every record of the life names it, and the copy
 * registration spooled may have been spent by then (an older connector's
 * flush, a refusal while the hub did not know the life). The heal used to send
 * it once, ahead of its one re-send, with a second copy spooled at the tail.
 * Any failure of that one POST — a 503, a timeout, no room left, a full batch
 * plus the work context past MAX_INGEST_BATCH — left the backlog to a flush
 * with no work context ahead of it, and every record was refused
 * `author_unknown` and spent. The tail copy came too late to help, and could
 * revert a status `set_intent` had set since.
 *
 * So the debt is written down: `<slug>.owed-wc` beside the host session's
 * spool, in the same locked step that switches the state to the life
 * (flows/heal-session.ts). Every drain that sends a batch carrying the life's
 * records sends the owed work context at its head (spool/flush.ts), and the
 * debt is settled only when the hub's answer for that record is accepted or a
 * duplicate. Beside the spool, not in the state file: SessionEnd deletes the
 * state while the records the debt is owed for may still wait on disk.
 *
 * WHAT IS PAID IS BUILT WHEN IT GOES (review-2 round 7, M1): the title and
 * status the life's state holds at the send, not the heal's snapshot — and
 * set_intent's own post for the work context settles the debt, so no copy is
 * ever sent over the status it set.
 */
import { z } from "zod";

import { MAX_SPOOL_AGE_DAYS, MS_PER_DAY, OWED_WORK_CONTEXT_MAX_REFUSALS } from "../constants.ts";
import {
  readJsonOrNull,
  removeFile,
  sessionSlug,
  sessionStatePathForSlug,
  spoolOwedWorkContextPath,
  writePrivateFile,
} from "../config/paths.ts";
import { withProducer, workContextRecord } from "../capture/records.ts";
import type { Producer } from "../capture/records.ts";
import type { HubContext } from "../http/client.ts";
import { postRecords } from "../http/hub.ts";
import type { IngestSummary, RecordResult } from "../http/hub.ts";
import { underSessionStateLock } from "../state/session-state.ts";
import { recordDrop } from "./drops.ts";
import { rejectCauseOf } from "./reject-cause.ts";

/** What a heal writes down: the life, and the work context it owes the hub. */
export interface WorkContextDebt {
  /** The life the work context belongs to. */
  readonly sessionId: string;
  /** The work_context envelope, as the heal built it. */
  readonly record: Record<string, unknown>;
}

/** The debt as it stands: how often the hub has refused it, and since when (review-2 round 7, M3). */
export interface OwedWorkContext extends WorkContextDebt {
  readonly refusals: number;
  readonly firstRefusedAt: string | null;
}

const OwedSchema = z.looseObject({
  sessionId: z.string().min(1),
  record: z.looseObject({ id: z.string().min(1), kind: z.literal("work_context") }),
  refusals: z.number().int().min(0).optional(),
  firstRefusedAt: z.string().min(1).optional(),
});

/** What the debt file holds: nothing, a debt, or bytes that are not one. */
export type DebtFile =
  | { readonly kind: "none" }
  | { readonly kind: "owed"; readonly owed: OwedWorkContext }
  | { readonly kind: "unreadable" };

/**
 * The debt file as it is — a file that exists and will not parse is its own
 * answer, never "nothing owed" (doctor reports it, review-2 round 7 L4).
 */
export const readDebtFile = async (home: string, key: string, slug: string): Promise<DebtFile> => {
  const path = spoolOwedWorkContextPath(home, key, slug);
  if (!(await Bun.file(path).exists())) {
    return { kind: "none" };
  }
  const parsed = OwedSchema.safeParse(await readJsonOrNull(path));
  return parsed.success
    ? {
        kind: "owed",
        owed: {
          sessionId: parsed.data.sessionId,
          record: parsed.data.record,
          refusals: parsed.data.refusals ?? 0,
          firstRefusedAt: parsed.data.firstRefusedAt ?? null,
        },
      }
    : { kind: "unreadable" };
};

export const readOwedWorkContext = async (
  home: string,
  key: string,
  slug: string,
): Promise<OwedWorkContext | null> => {
  const file = await readDebtFile(home, key, slug);
  return file.kind === "owed" ? file.owed : null;
};

/** Written by the heal's switch, under the state lock (flows/heal-session.ts) — a new debt, never refused. */
export const oweWorkContext = async (home: string, key: string, slug: string, owed: WorkContextDebt): Promise<void> => {
  await writePrivateFile(
    spoolOwedWorkContextPath(home, key, slug),
    `${JSON.stringify({ sessionId: owed.sessionId, record: owed.record })}\n`,
  );
};

/** The host session a spool slug belongs to; null for a name no slug is. */
const hostSessionKeyOf = (slug: string): string | null => {
  try {
    return decodeURIComponent(slug);
  } catch {
    return null;
  }
};

/** The work context a work_context envelope is for — its body's id. */
export const workContextIdOf = (record: Record<string, unknown>): unknown =>
  (record["body"] as { id?: unknown } | undefined)?.id;

/**
 * Settled once the hub has the work context — compare-and-delete by its id
 * under the host session's state lock, so a heal that owes ANOTHER work
 * context in between keeps its debt. A lock that stays busy leaves the debt:
 * paying it twice costs the hub a duplicate.
 */
export const settleOwedWorkContext = async (
  home: string,
  key: string,
  slug: string,
  workContextId: unknown,
): Promise<void> => {
  const hostSessionKey = hostSessionKeyOf(slug);
  if (hostSessionKey === null) {
    return;
  }
  await underSessionStateLock(home, hostSessionKey, undefined, async () => {
    const owed = await readOwedWorkContext(home, key, slug);
    if (owed !== null && workContextIdOf(owed.record) === workContextId) {
      await removeFile(spoolOwedWorkContextPath(home, key, slug));
    }
    return undefined;
  });
};

/**
 * set_intent's post for the life's work context is a payment too (review-2
 * round 7, M1): once the hub took it — accepted or a duplicate — the debt for
 * that work context is settled, and no later flush sends an older copy over it.
 */
export const settleOwedOnIntent = (
  home: string,
  key: string,
  hostSessionKey: string,
  workContextId: string,
): Promise<void> => settleOwedWorkContext(home, key, sessionSlug(hostSessionKey), workContextId);

/** What became of a debt the hub answered for (`answerOwed`). */
export type OwedOutcome = "settled" | "refused" | "released" | "open";

/** The causes that say the PRODUCER is dead to the hub: the heal's to answer, never the debt's refusal. */
const OWN_SESSION_CAUSES: ReadonlySet<string> = new Set(["session_ended", "session_unknown"]);

/** Whether the hub's refusal of a debt reached its bound: N refusals, or MAX_SPOOL_AGE_DAYS since the first. */
const isPastBound = (refusals: number, firstRefusedAt: string, now: Date): boolean =>
  refusals >= OWED_WORK_CONTEXT_MAX_REFUSALS ||
  now.getTime() - Date.parse(firstRefusedAt) >= MAX_SPOOL_AGE_DAYS * MS_PER_DAY;

/**
 * One more refusal on the debt for `workContextId` — and, past its bound, the
 * debt RELEASED (review-2 round 7, M3): counted as one drop with its own
 * cause, `owed_wc_refused`, and gone, so it neither pins its life's records
 * for good nor holds SessionEnd open. Under the state lock, compared like a
 * settle: a heal that owes another work context in between keeps its debt.
 */
const recordRefusal = async (
  home: string,
  key: string,
  slug: string,
  workContextId: unknown,
  now: Date,
): Promise<OwedOutcome> => {
  const hostSessionKey = hostSessionKeyOf(slug);
  if (hostSessionKey === null) {
    return "open";
  }
  return underSessionStateLock<OwedOutcome>(home, hostSessionKey, "open", async () => {
    const owed = await readOwedWorkContext(home, key, slug);
    if (owed === null || workContextIdOf(owed.record) !== workContextId) {
      return "open";
    }
    const refusals = owed.refusals + 1;
    const firstRefusedAt = owed.firstRefusedAt ?? now.toISOString();
    if (!isPastBound(refusals, firstRefusedAt, now)) {
      await writePrivateFile(
        spoolOwedWorkContextPath(home, key, slug),
        `${JSON.stringify({ sessionId: owed.sessionId, record: owed.record, refusals, firstRefusedAt })}\n`,
      );
      return "refused";
    }
    await recordDrop(home, key, slug, 1, "rejected", now, { work_context: 1 }, { owed_wc_refused: 1 });
    await removeFile(spoolOwedWorkContextPath(home, key, slug));
    return "released";
  });
};

/**
 * The hub's answer for an owed work context it was sent: settled when it took
 * it; one refusal counted when it refused the record itself; nothing when it
 * refused the session that sent it — the heal answers that — or said nothing.
 */
export const answerOwed = async (
  home: string,
  key: string,
  slug: string,
  workContextId: unknown,
  answer: RecordResult | undefined,
  now: Date,
): Promise<OwedOutcome> => {
  if (isTaken(answer)) {
    await settleOwedWorkContext(home, key, slug, workContextId);
    return "settled";
  }
  const isRecordRefused = answer?.status === "rejected" && !OWN_SESSION_CAUSES.has(rejectCauseOf(answer.issues));
  return isRecordRefused ? recordRefusal(home, key, slug, workContextId, now) : "open";
};

interface StateNaming {
  readonly crosscheckSessionId?: unknown;
  readonly workContextTitle?: unknown;
  readonly workContextStatus?: unknown;
}

const textOr = (value: unknown, fallback: unknown): string =>
  typeof value === "string" ? value : typeof fallback === "string" ? fallback : "";

/**
 * THE OWED WORK CONTEXT AS IT GOES NOW (review-2 round 7, M1): built when it
 * is sent, from the title and status the life's state holds then — never the
 * snapshot the heal took. A status `set_intent` set since the heal is the
 * hub's to keep; paying the snapshot reverted it. A fresh envelope every
 * send, so the hub never answers a stale copy `duplicate` over a newer
 * status. A state that no longer names the life — SessionEnd ran — leaves the
 * heal's own copy, the last the life said.
 */
export const owedRecordNow = async (
  home: string,
  slug: string,
  owed: OwedWorkContext,
  now: Date,
): Promise<Record<string, unknown>> => {
  const state = (await readJsonOrNull(sessionStatePathForSlug(home, slug))) as StateNaming | null;
  const named = state !== null && state.crosscheckSessionId === owed.sessionId ? state : null;
  const body = (owed.record["body"] ?? {}) as Record<string, unknown>;
  return workContextRecord(
    {
      workContextId: textOr(body["id"], ""),
      sessionId: textOr(body["sessionId"], owed.sessionId),
      title: textOr(named?.workContextTitle, body["title"]),
      status: textOr(named?.workContextStatus, body["status"]),
    },
    owed.record["producer"] as Producer,
    now,
  );
};

/** Whether a spooled record was written by the life a debt is for. */
export const isOwedFor = (owed: OwedWorkContext, record: Record<string, unknown>): boolean =>
  (record["producer"] as { sessionId?: unknown } | undefined)?.sessionId === owed.sessionId;

const TAKEN: ReadonlySet<string> = new Set(["accepted", "duplicate"]);

/** Whether the hub's answer for one record means it has that record now. */
export const isTaken = (result: RecordResult | undefined): boolean =>
  result !== undefined && TAKEN.has(result.status);

const countOf = (results: readonly RecordResult[], status: string): number =>
  results.filter((result) => result.status === status).length;

/** The batch's answers without the one for the record sent ahead of it, indexed as the batch knows them. */
const withoutAhead = (summary: IngestSummary): IngestSummary => {
  if (summary.results === undefined) {
    return summary;
  }
  const results = summary.results
    .filter((result) => result.index > 0)
    .map((result) => ({ ...result, index: result.index - 1 }));
  return {
    accepted: countOf(results, "accepted"),
    duplicates: countOf(results, "duplicate"),
    ignored: countOf(results, "ignored"),
    rejected: countOf(results, "rejected"),
    results,
  };
};

export interface OwedDelivery {
  /** The hub's answer for the batch, as if the owed record had not gone ahead. */
  readonly summary: IngestSummary;
  /** The hub's answer for the owed record itself (`answerOwed`). */
  readonly owedAnswer: RecordResult | undefined;
}

/**
 * Sends the batch with the owed work context at its head, built now
 * (`owedRecordNow`). Null when the hub did not take the request at all; the
 * debt and the batch both wait.
 */
export const deliverOwed = async (
  ctx: HubContext,
  slug: string,
  owed: OwedWorkContext,
  developerId: string | null,
  flusherSessionId: string,
  records: readonly Record<string, unknown>[],
): Promise<OwedDelivery | null> => {
  const ahead = withProducer(await owedRecordNow(ctx.home, slug, owed, ctx.now()), developerId, flusherSessionId);
  const result = await postRecords(ctx, [ahead, ...records]);
  if (!result.ok) {
    return null;
  }
  return {
    summary: withoutAhead(result.data),
    owedAnswer: result.data.results?.find((answer) => answer.index === 0),
  };
};
