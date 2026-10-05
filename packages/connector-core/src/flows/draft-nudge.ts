/**
 * `deliverDraftNudge` — the draft review nudge's WHEN (briefing/draft-nudge.ts
 * is its WHAT): once per session, on a prompt-time injection slot after the
 * session has finished DRAFT_NUDGE_MIN_FINISHED_TURNS, the agent is asked to
 * settle the developer's own drafts that have waited DRAFT_NUDGE_MIN_AGE_HOURS
 * — with the person, through review_draft.
 *
 * WHY A PROMPT-TIME SLOT AND NOT THE STOP HOOK. A Stop hook cannot ask the
 * person anything: both of Claude Code's Stop outputs (`decision: block` and
 * `additionalContext`) keep the agent's turn GOING, and Cursor's stop output
 * auto-submits a user message. Auto-continuing the person's session is not
 * crosscheck's to do (DESIGN-agent-agnostic.md, the stop row), so the nudge
 * rides the slot every host already gives an injection: Claude's
 * UserPromptSubmit, Cursor's postToolUse, the ACP proxy's prompt block. It
 * yields to the deferred briefing and to a hint on the same prompt — team
 * knowledge outranks housekeeping — and simply waits for the next one.
 *
 * WHAT SPENDS THE SLOT, AND WHAT DOES NOT. Only an ANSWER from the hub: the
 * nudge delivered, or nothing due (`nothing_due`) — so a session costs at most
 * one `GET /api/drafts` once the hub answers. An unreachable hub, a session
 * with no finished turn, a session no person reads, or a budget too thin to
 * look leave the slot untouched for a later prompt. Record-then-emit under the
 * state lock, like the hint: a crash between the two costs one nudge, never a
 * second one.
 *
 * IT PUBLISHES NOTHING and deletes nothing. The text asks; review_draft —
 * unchanged — is the only writer, and a discarded draft is superseded on the
 * hub, so it never comes back into this count.
 */
import { DRAFT_NUDGE_MIN_FINISHED_TURNS, DRAFT_NUDGE_MIN_SPARE_MS } from "../constants.ts";
import { DRAFT_DUE_AGE_MS, backlogOf, countAtLeastAged } from "../briefing/draft-backlog.ts";
import type { DraftBacklog } from "../briefing/draft-backlog.ts";
import { renderDraftNudge } from "../briefing/draft-nudge.ts";
import { getDraftListing } from "../http/hub.ts";
import type { HubContext } from "../http/hub.ts";
import { readSessionState, updateSessionState } from "../state/session-state.ts";
import type { SessionState } from "../state/session-state.ts";

export interface DeliverDraftNudgeInput {
  readonly home: string;
  readonly hub: HubContext;
  /** The host's own id for the session — the state file key. */
  readonly hostSessionKey: string;
  readonly repoId: string;
  readonly now: Date;
  /** False for a run no person reads: the nudge asks a person, so it is not spent there. */
  readonly personReads: boolean;
  /** What the caller's budget still spares; absent, the hub timeout alone bounds the GET. */
  readonly spareMs?: () => number;
}

/** The lockless pre-check: every prompt after the slot is spent costs one state read. */
export const isDraftNudgeOpen = (state: SessionState | null): state is SessionState =>
  state !== null &&
  state.draftNudge === null &&
  state.stopTurnCount >= DRAFT_NUDGE_MIN_FINISHED_TURNS;

const boundedHub = (input: DeliverDraftNudgeInput): HubContext | null => {
  if (input.spareMs === undefined) {
    return input.hub;
  }
  const spare = input.spareMs();
  return spare < DRAFT_NUDGE_MIN_SPARE_MS
    ? null
    : { ...input.hub, timeoutMs: Math.min(input.hub.timeoutMs, spare) };
};

/** Spends the slot under the lock; true only for the caller that spent it. */
const claimSlot = (
  input: DeliverDraftNudgeInput,
  outcome: "delivered" | "nothing_due",
): Promise<boolean> =>
  updateSessionState(input.home, input.hostSessionKey, (fresh) =>
    fresh.draftNudge !== null ? null : { ...fresh, draftNudge: outcome },
  );

/**
 * The backlog, with the oldest-first page too whenever it runs past the
 * newest-first one: the drafts that waited longest are exactly the ones a
 * newest-first page leaves out, and a nudge that cannot name them would spend
 * the session's slot on nothing while they rot. Only a page the hub SAYS is
 * oldest-first is used as one — an older hub ignores the parameter.
 */
const fetchBacklog = async (input: DeliverDraftNudgeInput): Promise<DraftBacklog | null> => {
  const hub = boundedHub(input);
  if (hub === null) {
    return null;
  }
  const listing = await getDraftListing(hub, input.repoId);
  if (!listing.ok) {
    return null;
  }
  const pastPage = listing.data.total !== null && listing.data.total > listing.data.drafts.length;
  const again = pastPage ? boundedHub(input) : null;
  if (again === null) {
    return backlogOf(listing.data);
  }
  const oldest = await getDraftListing(again, input.repoId, "oldest");
  return backlogOf(listing.data, oldest.ok && oldest.data.order === "oldest" ? oldest.data : null);
};

/** "" whenever nothing is owed or the slot was not this caller's to spend. */
export const deliverDraftNudge = async (input: DeliverDraftNudgeInput): Promise<string> => {
  if (!input.personReads) {
    return "";
  }
  const state = await readSessionState(input.home, input.hostSessionKey);
  if (!isDraftNudgeOpen(state)) {
    return "";
  }
  const backlog = await fetchBacklog(input);
  if (backlog === null) {
    return "";
  }
  const text = renderDraftNudge({ backlog, now: input.now });
  if (text.length > 0) {
    return (await claimSlot(input, "delivered")) ? text : "";
  }
  // NEVER SPENT WHILE A DUE DRAFT EXISTS: a draft this fetch could not name
  // (the oldest-first page failed, or the hub could not say) is still owed a
  // nudge, so the slot waits for a prompt that can name it.
  if (countAtLeastAged(backlog, DRAFT_DUE_AGE_MS, input.now).count > 0) {
    return "";
  }
  await claimSlot(input, "nothing_due");
  return "";
};
