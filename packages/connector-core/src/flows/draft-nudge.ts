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
import {
  DRAFT_NUDGE_MIN_FINISHED_TURNS,
  DRAFT_NUDGE_MIN_SPARE_MS,
  DRAFT_NUDGE_RETRY_COOLDOWN_MS,
} from "../constants.ts";
import { DRAFT_DUE_AGE_MS, backlogOf, countAtLeastAged } from "../briefing/draft-backlog.ts";
import type { DraftBacklog } from "../briefing/draft-backlog.ts";
import { renderDraftNudge } from "../briefing/draft-nudge.ts";
import { getDraftListing } from "../http/hub.ts";
import type { HubContext } from "../http/hub.ts";
import type { NudgeOutcome } from "../state/draft-nudge-spent.ts";
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

/**
 * Spends the slot under the lock; true only for the caller that spent it.
 * The session's own state is the only write on the prompt path: SessionEnd
 * records the slot per conversation and SessionStart seeds it back
 * (state/draft-nudge-spent.ts), so a resumed conversation is not nudged again.
 */
const claimSlot = (input: DeliverDraftNudgeInput, outcome: NudgeOutcome): Promise<boolean> =>
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
/** What one attempt to read the backlog came to. */
type BacklogFetch =
  | { readonly kind: "skipped" }
  | { readonly kind: "failed" }
  | { readonly kind: "backlog"; readonly backlog: DraftBacklog };

const fetchBacklog = async (input: DeliverDraftNudgeInput): Promise<BacklogFetch> => {
  const hub = boundedHub(input);
  if (hub === null) {
    return { kind: "skipped" };
  }
  const listing = await getDraftListing(hub, input.repoId);
  if (!listing.ok) {
    return { kind: "failed" };
  }
  const pastPage = listing.data.total !== null && listing.data.total > listing.data.drafts.length;
  const again = pastPage ? boundedHub(input) : null;
  if (again === null) {
    return { kind: "backlog", backlog: backlogOf(listing.data) };
  }
  const oldest = await getDraftListing(again, input.repoId, "oldest");
  return {
    kind: "backlog",
    backlog: backlogOf(listing.data, oldest.ok && oldest.data.order === "oldest" ? oldest.data : null),
  };
};

/**
 * A FAILED fetch is remembered for DRAFT_NUDGE_RETRY_COOLDOWN_MS: the nudge
 * is housekeeping, and an unresponsive hub must not cost every prompt one
 * more GET and its timeout. So is an attempt that found due drafts it could
 * not name, whatever the reason (prepareDraftNudge). A budget too thin for
 * even the first GET is not a failure: nothing was asked, nothing is owed.
 */
const isCoolingDown = (state: SessionState, now: Date): boolean =>
  state.draftNudgeRetryAt !== null && now.getTime() < Date.parse(state.draftNudgeRetryAt);

const coolDown = (input: DeliverDraftNudgeInput): Promise<boolean> =>
  updateSessionState(input.home, input.hostSessionKey, (fresh) => ({
    ...fresh,
    draftNudgeRetryAt: new Date(input.now.getTime() + DRAFT_NUDGE_RETRY_COOLDOWN_MS).toISOString(),
  }));

/**
 * A nudge ready to show, and the act that spends the slot on it — kept apart
 * so a caller whose budget can abandon the work (the ACP proxy races it and
 * lets the loser run on) spends the slot only once the text is certainly
 * going out. `text` "" means nothing is due; committing then spends the slot
 * as `nothing_due`, which shows nothing and so can never be lost.
 */
export interface PreparedDraftNudge {
  readonly text: string;
  readonly commit: () => Promise<boolean>;
}

/** Null whenever nothing is owed, nothing can be fetched now, or a due draft is unnameable. */
export const prepareDraftNudge = async (
  input: DeliverDraftNudgeInput,
): Promise<PreparedDraftNudge | null> => {
  if (!input.personReads) {
    return null;
  }
  const state = await readSessionState(input.home, input.hostSessionKey);
  if (!isDraftNudgeOpen(state) || isCoolingDown(state, input.now)) {
    return null;
  }
  const fetched = await fetchBacklog(input);
  if (fetched.kind !== "backlog") {
    if (fetched.kind === "failed") {
      await coolDown(input);
    }
    return null;
  }
  const text = renderDraftNudge({ backlog: fetched.backlog, now: input.now });
  if (text.length > 0) {
    return { text, commit: () => claimSlot(input, "delivered") };
  }
  // NEVER SPENT WHILE A DUE DRAFT EXISTS: a draft this fetch could not name
  // is still owed a nudge, so the slot waits for a prompt that can name it —
  // and the wait is the cooldown, FOR ANY REASON no page named one: the
  // oldest-first GET failed, an older hub ignored the order (no echo), the
  // budget had no room for the second GET, or no due row had a line to print.
  // Retrying on the next prompt asks the same question of the same hub; the
  // review's probe measured 12 GETs over 6 prompts that way.
  if (countAtLeastAged(fetched.backlog, DRAFT_DUE_AGE_MS, input.now).count > 0) {
    await coolDown(input);
    return null;
  }
  return { text: "", commit: () => claimSlot(input, "nothing_due") };
};

/**
 * Prepare and spend at once, for a caller that emits what this returns
 * before anything can abandon it (a hook's own handler). "" whenever nothing
 * is owed or the slot was not this caller's to spend.
 */
export const deliverDraftNudge = async (input: DeliverDraftNudgeInput): Promise<string> => {
  const prepared = await prepareDraftNudge(input);
  if (prepared === null) {
    return "";
  }
  return (await prepared.commit()) ? prepared.text : "";
};
