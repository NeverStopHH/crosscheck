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
 */
import { z } from "zod";

import { readJsonOrNull, removeFile, spoolOwedWorkContextPath, writePrivateFile } from "../config/paths.ts";
import { withProducer } from "../capture/records.ts";
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

/**
 * Settled once the hub took the record — compare-and-delete under the host
 * session's state lock, so a heal that owes a newer work context in between
 * keeps its debt. A lock that stays busy leaves the debt: paying it twice
 * costs the hub a duplicate.
 */
export const settleOwedWorkContext = async (
  home: string,
  key: string,
  slug: string,
  record: Record<string, unknown>,
): Promise<void> => {
  const hostSessionKey = hostSessionKeyOf(slug);
  if (hostSessionKey === null) {
    return;
  }
  await underSessionStateLock(home, hostSessionKey, undefined, async () => {
    const owed = await readOwedWorkContext(home, key, slug);
    if (owed !== null && owed.record["id"] === record["id"]) {
      await removeFile(spoolOwedWorkContextPath(home, key, slug));
    }
    return undefined;
  });
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
 * Sends the batch with the owed work context at its head. Null when the hub
 * did not take the request at all; the debt and the batch both wait.
 */
export const deliverOwed = async (
  ctx: HubContext,
  owed: OwedWorkContext,
  developerId: string | null,
  flusherSessionId: string,
  records: readonly Record<string, unknown>[],
): Promise<OwedDelivery | null> => {
  const result = await postRecords(ctx, [withProducer(owed.record, developerId, flusherSessionId), ...records]);
  if (!result.ok) {
    return null;
  }
  return {
    summary: withoutAhead(result.data),
    owedTaken: isTaken(result.data.results?.find((answer) => answer.index === 0)),
  };
};
