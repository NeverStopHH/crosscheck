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

export interface OwedWorkContext {
  /** The life the work context belongs to. */
  readonly sessionId: string;
  /** The work_context envelope, as the heal built it. */
  readonly record: Record<string, unknown>;
}

const OwedSchema = z.looseObject({
  sessionId: z.string().min(1),
  record: z.looseObject({ id: z.string().min(1), kind: z.literal("work_context") }),
});

export const readOwedWorkContext = async (
  home: string,
  key: string,
  slug: string,
): Promise<OwedWorkContext | null> => {
  const parsed = OwedSchema.safeParse(await readJsonOrNull(spoolOwedWorkContextPath(home, key, slug)));
  return parsed.success ? { sessionId: parsed.data.sessionId, record: parsed.data.record } : null;
};

/** Written by the heal's switch, under the state lock (flows/heal-session.ts). */
export const oweWorkContext = async (home: string, key: string, slug: string, owed: OwedWorkContext): Promise<void> => {
  await writePrivateFile(spoolOwedWorkContextPath(home, key, slug), `${JSON.stringify(owed)}\n`);
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
  /** The hub took the owed record: the debt may be settled. */
  readonly owedTaken: boolean;
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
    owedTaken: isTaken(result.data.results?.find((answer) => answer.index === 0)),
  };
};
