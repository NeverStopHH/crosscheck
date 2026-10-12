/**
 * THE 30 s REST IS ONLY AS GOOD AS ITS RECHECK (round 3, F-M2, accepted on
 * the owner's condition: the recheck is guaranteed, or its absence is a
 * counted loss).
 *
 * Within TRIPWIRE_RECHECK_TTL_MS of an answer this session fully dealt with,
 * an edit of the file asks the hub nothing, so a teammate who starts on it
 * inside that rest is seen by no edit. Every rest therefore leaves a DEBT in
 * session state (`tripwireCheckedFiles`, with when it began) that only a
 * tripwire call about the file pays:
 *
 *   - the turn's end (hooks/turn-end.ts) rechecks the debts, at most
 *     TURN_END_RECHECK_MAX_FILES, newest first, and keeps the ones it could
 *     not ask about — past its cap, out of budget, or unanswered;
 *   - every other sync hook (PreToolUse, UserPromptSubmit, the
 *     subagent-return hook) rechecks the debts whose rest is OVER — the turn
 *     crashed, was killed or cut, Stop never fired, or the cap kept them —
 *     within its own budget, and BOOKS the ones the hub would not answer as a
 *     `rest_unchecked` capture loss, counted per file; the ones it had no
 *     room to ask about stay for the next hook;
 *   - SessionEnd books whatever is still owed (no hook will run after it),
 *     and the reaper books a dead session's (state/session-reap.ts).
 *
 * A debt is never dropped in silence: paid, kept, or booked. A teammate a
 * recheck finds and the person was never told of is told now, as the
 * tripwire tells them.
 */
import { anonymousTripwireCollision, tripwireCollision } from "@crosscheck/connector-core/hints/collision-notice.ts";
import { TURN_END_RECHECK_MAX_FILES } from "@crosscheck/connector-core/constants.ts";
import { getTripwireSessions } from "@crosscheck/connector-core/http/hub.ts";
import type { CoverageRecord } from "@crosscheck/connector-core/http/coverage.ts";
import type { TripwireSession } from "@crosscheck/connector-core/http/hub.ts";
import { recordCaptureLoss } from "@crosscheck/connector-core/state/loss-ledger.ts";
import { recordRestOmission } from "@crosscheck/connector-core/state/rest-omissions.ts";
import {
  newCollisionKeys,
  owedRests,
  overdueRests,
  readSessionState,
  stillOwed,
  updateSessionState,
  withCollisionNotices,
  withOverdueRest,
  withQueuedCollisionRelays,
  withRestsDroppedBooked,
  withoutTripwireRests,
} from "@crosscheck/connector-core/state/session-state.ts";
import type { CollisionNotice, SessionState, TripwireCheck } from "@crosscheck/connector-core/state/session-state.ts";
import type { HookBudget, HookContext } from "./runner.ts";

/**
 * One group per (teammate, work context) — a hub answer that lists the same
 * pair twice, two windows on one piece of work, is ONE line for the person
 * (round 2, L7), and so are two rechecked files of one teammate's work.
 */
export const onePerKey = (groups: readonly CollisionNotice[]): readonly CollisionNotice[] =>
  groups.filter((group, index) => groups.findIndex((other) => other.key === group.key) === index);

/** What one recheck came to: not asked (no room), asked and unanswered, or answered. */
type Outcome =
  | { readonly kind: "unasked"; readonly rest: TripwireCheck }
  | { readonly kind: "failed"; readonly rest: TripwireCheck }
  | {
      readonly kind: "answered";
      readonly rest: TripwireCheck;
      readonly sessions: readonly TripwireSession[];
      /** The answer said a teammate it will not name is live on the file. */
      readonly anonymous: boolean;
      readonly coverage: CoverageRecord;
    };

type Answered = Extract<Outcome, { kind: "answered" }>;

const isAnswered = (outcome: Outcome): outcome is Answered => outcome.kind === "answered";

/** ONE tripwire call for one owed rest, held to the request timeout and to what the budget spares. */
const recheckOf = async (ctx: HookContext, budget: HookBudget, rest: TripwireCheck): Promise<Outcome> => {
  const timeoutMs = Math.min(ctx.hub.timeoutMs, budget.spareMs());
  if (timeoutMs <= 0) {
    return { kind: "unasked", rest };
  }
  const result = await getTripwireSessions({ ...ctx.hub, timeoutMs }, ctx.identity.repoId, rest.file);
  return result.ok
    ? { kind: "answered", rest, sessions: result.data.sessions, anonymous: result.data.anonymous, coverage: result.data.coverage }
    : { kind: "failed", rest };
};

/** How one hook pays the debts it asks about. */
export interface RestPolicy {
  /** The hook, as the loss ledger names it. */
  readonly detail: string;
  /** A recheck the hub did not answer: KEPT for a later hook, or BOOKED as a loss now. */
  readonly onFailure: "keep" | "book";
}

/** The fields a pass can change: nothing to write when none of them did. */
const passFieldsOf = (state: SessionState): string =>
  JSON.stringify([state.collisionNotices, state.collisionRelayQueue, state.tripwireCheckedFiles, state.tripwireRestsDropped]);

/**
 * Asks about these owed rests, side by side, and settles them in ONE locked
 * check-and-set: every answered one is paid, every group the answers name is
 * recorded and the ones new to this session returned to be told (queued for
 * the main thread too when this is a subagent's hook), every unanswered one
 * is kept or booked as the policy says — only while the state still holds
 * that very rest, so a racing hook never pays or books it twice — and any
 * debt the FIFO cap had to evict is booked with it.
 */
export const recheckRests = async (
  ctx: HookContext,
  budget: HookBudget,
  rests: readonly TripwireCheck[],
  policy: RestPolicy,
): Promise<readonly CollisionNotice[]> => {
  if (rests.length === 0) {
    return [];
  }
  const outcomes = await Promise.all(rests.map((rest) => recheckOf(ctx, budget, rest)));
  const answered = outcomes.filter(isAnswered);
  const failed = policy.onFailure === "book" ? outcomes.filter((outcome) => outcome.kind === "failed").map((outcome) => outcome.rest) : [];
  const settled = [...answered.map((outcome) => outcome.rest), ...failed];
  if (settled.length === 0) {
    return [];
  }
  // The nameless teammate's group as the edit builds it, after the named
  // ones: the same group, so a person told once is not told again.
  const groups = onePerKey(
    answered.flatMap((outcome) => [
      ...outcome.sessions.map((session) => tripwireCollision(session, outcome.rest.file, outcome.coverage)),
      ...(outcome.anonymous ? [anonymousTripwireCollision(outcome.rest.file, outcome.coverage)] : []),
    ]),
  );
  const told: { value: readonly CollisionNotice[] } = { value: [] };
  const booked: { value: number } = { value: 0 };
  const isWritten = await updateSessionState(ctx.config.home, ctx.payload.session_id, (fresh) => {
    const fresher = newCollisionKeys(fresh, groups);
    told.value = groups.filter((group) => fresher.includes(group.key));
    booked.value = stillOwed(fresh, failed).length + (fresh.tripwireRestsDropped ?? 0);
    const paid = withRestsDroppedBooked(withoutTripwireRests(withCollisionNotices(fresh, groups), settled));
    const next =
      ctx.payload.agent_id === undefined || told.value.length === 0
        ? paid
        : withQueuedCollisionRelays(paid, told.value.map((group) => group.key));
    return passFieldsOf(next) === passFieldsOf(fresh) ? null : next;
  });
  if (isWritten && booked.value > 0) {
    await bookUncheckedRests(ctx, booked.value, policy.detail);
  }
  return isWritten ? told.value : [];
};

/**
 * THE ONE BOOKING PATH for rests whose recheck never ran: the capture-loss
 * ledger (`rest_unchecked`, per file — doctor and status print it; it stays
 * off the hub's coverage, which no record was lost to, review batch 2 M3) and
 * the local omission ledger (one line per booking — the machine's count of
 * moments its person may not have been told; core state/rest-omissions.ts).
 * Exported for the one other hook that owes a rest it may fail to write: a
 * cut tripwire's undo under a lock that stays busy (hooks/pre-tool-use.ts
 * releaseCutStop; final review of batch 2, N3).
 */
export const bookUncheckedRests = async (ctx: HookContext, count: number, detail: string): Promise<void> => {
  await recordCaptureLoss(ctx.config.home, {
    kind: "rest_unchecked",
    count,
    key: ctx.repoKey,
    detail,
    now: ctx.now(),
  });
  await recordRestOmission(ctx.config.home, { key: ctx.repoKey, reason: "rest_unchecked", now: ctx.now() });
};

/**
 * Whether an owed rest is the file an edit is about to ask the hub about
 * itself — its repo-relative id is the tail of the edit's path. That edit's
 * own answer asks again, so the sweep beside it leaves the file alone; a
 * false match only leaves a debt for the next hook.
 */
const isEditedFile = (rest: TripwireCheck, editedPath: string | undefined): boolean =>
  editedPath !== undefined && editedPath.endsWith(`/${rest.file}`);

/**
 * What a hook other than the turn's end pays at its own next opportunity:
 * the debts whose rest is over, at most TURN_END_RECHECK_MAX_FILES of them,
 * within what the budget spares — an unanswered one booked, an unasked one
 * left for the next hook. `editedPath` is the file a PreToolUse is asking
 * about itself. Fail open: the hosting hook's own work is untouched.
 */
export const recheckOverdueRests = async (
  ctx: HookContext,
  budget: HookBudget,
  detail: string,
  editedPath?: string,
): Promise<readonly CollisionNotice[]> => {
  try {
    if (budget.spareMs() <= 0) {
      return [];
    }
    const state = await readSessionState(ctx.config.home, ctx.payload.session_id);
    const overdue = (state === null ? [] : overdueRests(state, ctx.now()))
      .filter((rest) => !isEditedFile(rest, editedPath))
      .slice(0, TURN_END_RECHECK_MAX_FILES);
    return await recheckRests(ctx, budget, overdue, { detail, onFailure: "book" });
  } catch {
    return [];
  }
};

/** Whether a state owes a recheck whose rest is over — what a hook's shortcut must not skip. */
export const hasOverdueRests = (state: SessionState, now: Date): boolean => overdueRests(state, now).length > 0;

/** Whether a state owes any recheck at all — what the turn-end hook's shortcut must not skip. */
export const hasOwedRests = (state: SessionState): boolean => owedRests(state).length > 0;

/**
 * AN UNANSWERED TRIPWIRE LEAVES A DEBT (review batch 2, M1): a live tripwire
 * call that failed — the hub at or past the request timeout — gave the edit no
 * agent text, no person line, no rest and no count. It now owes a recheck of
 * the file, already overdue (core state/session-state.ts withOverdueRest), so
 * the next sync hook asks again and tells the person, or books the file as
 * `rest_unchecked` when the hub still will not answer; a session that ends
 * first books it at SessionEnd. A state lock that stays busy books it here at
 * once rather than drop it. Fail open: the edit's own answer is untouched.
 */
export const oweUnansweredRecheck = async (ctx: HookContext, file: string, detail: string): Promise<void> => {
  try {
    const isOwed = await updateSessionState(ctx.config.home, ctx.payload.session_id, (fresh) =>
      withOverdueRest(fresh, file, ctx.now()),
    );
    if (!isOwed) {
      await bookUncheckedRests(ctx, 1, detail);
    }
  } catch {
    // Fail open, like every collision write on a hook path.
  }
};

/** Every recheck a state still owes, the evicted ones included. */
const owedCountOf = (state: SessionState): number =>
  (state.tripwireCheckedFiles ?? []).length + (state.tripwireRestsDropped ?? 0);

/**
 * The session is ending and no hook of it will run again: every debt still
 * owed is claimed in one locked write and booked, so a SessionEnd that does
 * not reach its state delete leaves nothing for the reaper to book twice.
 *
 * A LOCK THAT STAYS BUSY BOOKS FROM AN UNLOCKED READ (review batch 2, M8):
 * the state delete right after this falls back the same way
 * (core state/session-state.ts closeSessionState) and takes the debts with
 * it, so giving up here dropped them unbooked — 9 of 9 trials in the review.
 * A sibling paying one of them at the same moment books it once more, the
 * over-count's safe side.
 */
export const bookOwedRestsAtEnd = async (ctx: HookContext, detail: string): Promise<void> => {
  try {
    const owed: { value: number } = { value: 0 };
    const isWritten = await updateSessionState(ctx.config.home, ctx.payload.session_id, (fresh) => {
      owed.value = owedCountOf(fresh);
      return owed.value === 0 ? null : withRestsDroppedBooked({ ...fresh, tripwireCheckedFiles: [] });
    });
    const unlocked = isWritten ? null : await readSessionState(ctx.config.home, ctx.payload.session_id);
    const booked = isWritten ? owed.value : unlocked === null ? 0 : owedCountOf(unlocked);
    if (booked > 0) {
      await bookUncheckedRests(ctx, booked, detail);
    }
  } catch {
    // Fail open: an unbooked debt stays in the state file, where the reaper books it.
  }
};
