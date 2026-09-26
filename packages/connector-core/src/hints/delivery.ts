import { MAX_HINTS_PER_SESSION } from "../constants.ts";
import { hintDeliveryRecord, landedNoticeDeliveryRecord, UNKNOWN_DEVELOPER_ID } from "../capture/records.ts";
import type { HintRefKind, Producer } from "../capture/records.ts";
import { postRecords } from "../http/hub.ts";
import type { HubContext } from "../http/hub.ts";
import { recordDeliveredHintHash } from "./delivered-store.ts";
import { appendRecords } from "../spool/append.ts";
import {
  updateSessionState,
  withDeliveredHint,
  withShownLandedNotices,
} from "../state/session-state.ts";
import type { SessionState } from "../state/session-state.ts";
import type { DeliveryChannel } from "@crosscheck/schema";

/**
 * Recording a delivered hint — spool the `hint_deliveries` row, then CLAIM
 * the ref in session state, first writer wins.
 *
 * EXTRACTED from flows/hint.ts (which calls this now) because the
 * failure-time solved hint spends the SAME per-session budget from a
 * different hook, and two copies of a check-and-set are two answers to
 * "was this already delivered". Everything below is that function verbatim,
 * with the input narrowed to the fields it actually reads.
 */
export interface HintDeliveryTarget {
  readonly home: string;
  readonly repoKey: string;
  /** The host's own id for the session — the state file key. */
  readonly hostSessionKey: string;
  readonly agentKind: string;
  readonly hub: HubContext;
  readonly now: Date;
}

export interface PendingHintDelivery {
  readonly refKind: HintRefKind;
  readonly refId: string;
  readonly bodyHash: string | null;
  /**
   * WHICH SURFACE is handing this over (07 §3.1).
   *
   * On the delivery and not on the recorder, because three callers reach this
   * function and they are not the same channel — and required, so a fourth
   * cannot quietly book itself as `unknown` on the one record the pilot
   * report counts.
   */
  readonly channel: DeliveryChannel;
}

/**
 * False when the seen-set could not be updated — then nothing may be emitted.
 *
 * `shipNow` POSTS the delivery record instead of only spooling it, and it is
 * the ANSWER path that asks for it. "Delivered exactly once" across SESSIONS
 * is the hub's promise, and the hub can only keep it once a hint_deliveries
 * row exists — a spool append creates none, and UserPromptSubmit is the one
 * hook that never flushes. So between the render and the session's next
 * PostToolUse or Stop (minutes, on a long agent turn) every other live session
 * of the same developer still reads that answer as undelivered and injects it
 * again, spending one of its five hint slots on a repeat.
 *
 * ONLY the answer path, deliberately. A repeated POINTER costs one duplicate
 * line; an extra hub round trip on EVERY prompt costs the 800 ms hook budget,
 * and an answer is rare (at most MAX_QUESTION_ANSWERS_LISTED are ever waiting).
 * BEST EFFORT: a hub that refuses or times out leaves the spooled copy to
 * close the window at the next flush, exactly as before — the record carries
 * the same deterministic delivery id, so the hub absorbs the replay as a
 * duplicate rather than a second telemetry row.
 */
export const rememberHintDelivery = async (
  target: HintDeliveryTarget,
  state: SessionState,
  delivery: PendingHintDelivery,
  shipNow = false,
): Promise<boolean> => {
  const producer: Producer = {
    developerId: state.developerId ?? UNKNOWN_DEVELOPER_ID,
    agentKind: target.agentKind,
    sessionId: state.crosscheckSessionId,
  };
  // A local append, microseconds; the next flush ships it, and a dead hub
  // leaves it spooled like any other record (idempotent by delivery id).
  const record = hintDeliveryRecord(
    state.crosscheckSessionId,
    delivery.refKind,
    delivery.refId,
    delivery.channel,
    producer,
    target.now,
  );
  await appendRecords(
    target.home,
    target.repoKey,
    target.hostSessionKey,
    [record],
    target.now,
  );
  // Freshest state, under the state lock — and FIRST WRITER WINS, decided on
  // that fresh state: two hook processes can race ONE failure (the cursor
  // dual-signal case fires postToolUse and postToolUseFailure concurrently),
  // and both pass the lockless pre-checks in selectAndRenderHint before
  // either records. The transform is therefore a check-AND-set, the
  // tripwire's own shape: a ref already present, or a cap already reached by
  // a racing sibling, DECLINES the write — and unremembered means unemitted,
  // so the loser is silence, never a second copy of the same teammate
  // finding in one turn (§10 risk 1). The loser's spool append above carries
  // the winner's deterministic delivery id, so the hub absorbs it as a
  // duplicate — never a second telemetry row.
  const remembered = await updateSessionState(
    target.home,
    target.hostSessionKey,
    (fresh) =>
      fresh.deliveredHintRefs.includes(delivery.refId) ||
      fresh.deliveredHintRefs.length >= MAX_HINTS_PER_SESSION
        ? null
        : withDeliveredHint(fresh, delivery.refId, delivery.bodyHash),
  );
  // Substance hashes also persist per repo (hints/delivered-store.ts): the
  // echo-loop exclusion carries no session qualifier, and session state dies
  // at session end. Best-effort — the session-state copy above already covers
  // this session, so a busy lock here must not cost the hint.
  if (remembered && delivery.bodyHash !== null) {
    await recordDeliveredHintHash(target.home, target.repoKey, delivery.bodyHash);
  }
  // After the seen-set, never before: a shipped delivery for a hint this
  // session then declined to emit would tell the hub it was handed something
  // it never saw.
  if (remembered && shipNow) {
    await postRecords(target.hub, [record]);
  }
  return remembered;
};

/** An author's notice about to be told on a prompt (landed changes, step 4). */
export interface PendingLandedNoticeDelivery {
  /** The name it spends a hint slot under: its first row's id. */
  readonly slotRef: string;
  /** The hub rows the emitted text names — exactly these are marked told. */
  readonly commitIds: readonly string[];
}

/**
 * Telling an author's notice on a prompt (docs/1.0/landed-changes.md, step
 * 4): rememberHintDelivery's twin, with the order turned round ON PURPOSE.
 *
 * CLAIM FIRST, THEN RECORD. A hint's delivery is spooled before its claim,
 * because a losing sibling's copy carries the winner's deterministic id and
 * the hub drops it as a duplicate. A notice's delivery has no such id: it
 * MARKS ROWS TOLD. Spooled for a notice this session then declined to show —
 * a racing sibling won the claim, or the five hint slots were spent — it
 * would tell the hub the author saw what nobody showed, and the notice would
 * be gone for good. So: claim, then spool, then ship. A crash between claim
 * and spool costs this session the notice (claimed, never shown) and never
 * the author: the hub did not hear it was told, so a briefing still tells it.
 *
 * A notice spends one of the session's MAX_HINTS_PER_SESSION slots, like an
 * answer, and its rows join the session's shown list, which the briefing's
 * notices join too — so neither surface repeats the other.
 *
 * SHIPPED NOW, like an answer (see rememberHintDelivery on `shipNow`):
 * UserPromptSubmit never flushes, and until the hub hears it every other live
 * session of the author reads the notice as waiting. Best effort; the spooled
 * copy follows at the next flush, and marking a told row again changes
 * nothing.
 */
export const rememberLandedNoticeDelivery = async (
  target: HintDeliveryTarget,
  state: SessionState,
  delivery: PendingLandedNoticeDelivery,
): Promise<boolean> => {
  const remembered = await updateSessionState(target.home, target.hostSessionKey, (fresh) =>
    fresh.deliveredHintRefs.length >= MAX_HINTS_PER_SESSION ||
    fresh.deliveredHintRefs.includes(delivery.slotRef) ||
    delivery.commitIds.some((id) => fresh.shownLandedNoticeIds.includes(id))
      ? null
      : withShownLandedNotices(withDeliveredHint(fresh, delivery.slotRef, null), delivery.commitIds),
  );
  if (!remembered) {
    return false;
  }
  const record = landedNoticeDeliveryRecord(
    state.crosscheckSessionId,
    delivery.commitIds,
    {
      developerId: state.developerId ?? UNKNOWN_DEVELOPER_ID,
      agentKind: target.agentKind,
      sessionId: state.crosscheckSessionId,
    },
    target.now,
  );
  await appendRecords(target.home, target.repoKey, target.hostSessionKey, [record], target.now);
  await postRecords(target.hub, [record]);
  return true;
};
