/**
 * `selectAndRenderHint` (DESIGN-agent-agnostic.md §1.3) — the
 * UserPromptSubmit recipe as an extracted function: meaning floor → session
 * state (seen-set + cap) → ONE bounded hub call → `selectHint` → drift label
 * → `renderClaimHint`/`renderPointerHint` → record the delivery, THEN return
 * the text.
 *
 * EXTRACTED FROM `connector-claude/src/hooks/user-prompt-submit.ts` for
 * Block 5, not invented: the hook calls this now, and the ACP proxy's
 * per-prompt path calls the same function — one implementation of the whole
 * asymmetry pipeline (§4: evidence-backed substance, pointers for the rest,
 * silence on every doubt), so a selector or renderer change can never drift
 * between connectors.
 *
 * PRIVACY (Block 4's pin extends here): the prompt is an EPHEMERAL search
 * query. It is sliced for the hub call and never stored, spooled, or logged —
 * nothing in this module writes it anywhere. And it is SECRET-GATED before
 * the one hub call: `containsSecret` on the whole prompt, a hit means the
 * attempt is dropped — the query is the one place this text goes on the
 * wire, and the wire-level pin lives in connector-cursor/test/privacy.test.ts.
 * A prompt with no searchable word is not even that: it never goes on the
 * wire, and nothing travels in its place — not the session's intent either
 * (review 1006b, M6; test/hint-intent-fallback.test.ts). Such a turn, and a
 * turn the harness wrote, is COUNTED in session state, and only counted
 * (M7): the number, never a word of it.
 *
 * ORDER AT THE END IS THE CONTRACT: telemetry spool append, then session
 * state (seen-set + echo hash), then the caller emits. A crash — or a
 * caller's budget race resolving against a late hint — between state write
 * and emission costs one hint slot, the honest direction; the reverse order
 * could deliver the same hint twice, which is the noise §10 risk 1 forbids.
 * The delivery id is deterministic per (session, ref), so a replayed spool
 * re-sends the same primary key and the hub answers `duplicate` — never a
 * second telemetry row (the loads/resumes idempotency pin).
 */
import {
  LANDED_NOTICE_MIN_SPARE_MS,
  MAX_HINTS_PER_SESSION,
  MAX_SEARCH_QUERY_CHARS,
} from "../constants.ts";
import { containsSecret } from "../capture/secret-scan.ts";
import type { DeliveryMatching, HintRefKind } from "../capture/records.ts";
import { resolveCommitDrift } from "../git/commit-drift.ts";
import type { CommitDrift } from "../git/commit-drift.ts";
import { getHintCandidates } from "../http/hub.ts";
import type { AnsweredQuestion, HintCandidatesResult, HubContext, LandedNotice } from "../http/hub.ts";
import { rememberHintDelivery, rememberLandedNoticeDelivery } from "../hints/delivery.ts";
import { hintBodyHash } from "../hints/echo.ts";
import { classifyPrompt, isHarnessTurn, promptTerms, shownSubstance } from "@crosscheck/schema";
import type { ClassifiedPrompt, PromptTerms } from "@crosscheck/schema";
import {
  hintTrailerReserve,
  renderAnswerHint,
  renderClaimHint,
  renderLandedNoticeHint,
  renderPointerHint,
  withCoverageNote,
} from "../hints/render.ts";
import { SUBSTANCE_DELIVERY_CHANNEL } from "@crosscheck/schema";
import type { DeliveryChannel, IntentProvenance } from "@crosscheck/schema";
import { selectHint } from "../hints/select.ts";
import type { HintSelection } from "../hints/select.ts";
import {
  readSessionState,
  updateSessionState,
} from "../state/session-state.ts";
import type { SessionState } from "../state/session-state.ts";


export interface SelectAndRenderHintInput {
  readonly home: string;
  readonly repoKey: string;
  readonly hub: HubContext;
  /** The host's own id for the session — the state file key. */
  readonly hostSessionKey: string;
  readonly repoId: string;
  /** Drift resolves against this checkout; a slow git loses the label only. */
  readonly repoRoot: string;
  readonly agentKind: string;
  /** EPHEMERAL query — sliced for the hub call, never stored (see header). */
  readonly prompt: string;
  readonly now: Date;
  /**
   * Whether this host may tell an author's notice here (landed changes, step
   * 4): only on a prompt a person reads. Cursor's failure hint is not one —
   * its output field is undocumented and may be dropped silently, and a
   * notice told there would be marked told and never seen — so Cursor leaves
   * this off and its authors hear notices in the briefing. Off by default.
   */
  readonly tellsNotices?: boolean;
  /**
   * What the caller's budget still spares after its reserve. A notice is told
   * only while at least LANDED_NOTICE_MIN_SPARE_MS is spare, and its
   * immediate post gets no more (hints/delivery.ts). Absent, no notice is told.
   */
  readonly spareMs?: () => number;
  /**
   * The prompt as the caller already classified it (`@crosscheck/schema`
   * classifyPrompt) — the hook classifies ONCE for its intent fire and this
   * flow (hold-out review round 3, L4). Absent, the flow classifies it once.
   */
  readonly classified?: ClassifiedPrompt;
}

interface Delivery {
  readonly refKind: HintRefKind;
  readonly refId: string;
  readonly bodyHash: string | null;
  readonly text: string;
  /**
   * THE MID-PROMPT CHANNEL (07 §3.1). Everything this module emits reaches a
   * reader through UserPromptSubmit — it interrupts a turn already under way,
   * which is what makes its pull rate a different measurement from the
   * briefing's, and the reason the two are never one number again.
   */
  readonly channel: DeliveryChannel;
  /** What it was matched on, and whose intent the session held (M7). */
  readonly matching: DeliveryMatching;
}

/** What every rendering of one selection shares. */
interface RenderScope {
  readonly repoRoot: string;
  readonly now: Date;
  /** Who wrote the session intent a candidate may have been matched on. */
  readonly intentProvenance: IntentProvenance | null;
  /** What the lines appended after the hint need (`hintTrailerReserve`). */
  readonly reserveChars: number;
  /** The channel a shown finding is booked on (`substanceChannelOf`). */
  readonly substanceChannel: DeliveryChannel;
}

/**
 * A shown finding's own channel where the hub says it records it, else
 * prompt_hint (review 1006b): a hub older than `prompt_substance` rejects a
 * record carrying it, and a rejected delivery is no count at all. The older
 * hub then counts the finding as a pointer — the smaller loss of the two.
 */
const substanceChannelOf = (advertised: readonly string[]): DeliveryChannel =>
  advertised.includes(SUBSTANCE_DELIVERY_CHANNEL) ? SUBSTANCE_DELIVERY_CHANNEL : "prompt_hint";

const renderSelection = async (
  scope: RenderScope,
  selection: HintSelection,
): Promise<Delivery | null> => {
  if (selection.kind === "silence") {
    return null;
  }
  const context = selection.context.workContext;
  // Drift is a nice-to-have label: a slow or ignorant git loses it, never the
  // hint. Bounded by DRIFT_GIT_TIMEOUT_MS inside resolveCommitDrift.
  const drift: CommitDrift | null =
    context.baseCommit === undefined || context.baseCommit.length === 0
      ? null
      : await resolveCommitDrift(scope.repoRoot, context.baseCommit);
  return deliveryOf(scope, selection, drift);
};

/** One selection rendered with its tree's drift — the fallback shares both. */
const deliveryOf = (
  scope: RenderScope,
  selection: HintSelection,
  drift: CommitDrift | null,
): Delivery | null => {
  const { now, intentProvenance, reserveChars } = scope;
  if (selection.kind === "silence") {
    return null;
  }
  const context = selection.context.workContext;
  // What the hub matched this candidate on — the hint says which (§4), and
  // so does its delivery record (M7).
  const matchedOn = selection.context.matchedOn;
  const matching: DeliveryMatching = { matchedOn, intentProvenance };
  if (selection.kind === "claim") {
    const text = renderClaimHint({
      claim: selection.claim,
      context,
      drift,
      now,
      matchedOn,
      intentProvenance,
      restCount: selection.restCount,
      isRestLowerBound: selection.isRestLowerBound,
      reserveChars,
    });
    // TOO LONG TO SHOW WHOLE beside the lines appended after it: the
    // selector's pointer at the same tree goes out instead, booked as a
    // pointer — never a finding cut shorter than the sentence the hub scored.
    if (text.length === 0) {
      return deliveryOf(scope, selection.ifUnfit, drift);
    }
    return {
      refKind: "claim",
      refId: selection.claim.id,
      // The finding rides INSIDE this hint, so a later read of its tree is
      // the agent pulling more, never "the pointer was opened" (07 §3.1).
      channel: scope.substanceChannel,
      // The echo mark covers what was SHOWN — the first sentence — so that
      // sentence coming back as the reader's own observation is caught.
      bodyHash: hintBodyHash(shownSubstance(selection.claim.body)),
      text,
      matching,
    };
  }
  return {
    refKind: "work_context",
    refId: context.id,
    channel: "prompt_hint",
    bodyHash: null,
    matching,
    text: renderPointerHint({
      context,
      matchedOn,
      intentProvenance,
      claimCount: selection.claimCount,
      // #19: present only for a targets-only pointer, absent for the
      // claim-count one — the renderer branches on it, still no body either way.
      ...(selection.matchedTarget === undefined
        ? {}
        : { matchedTarget: selection.matchedTarget }),
      drift,
      now,
      reserveChars,
    }),
  };
};

/**
 * An answer to a question THIS developer asked, if one is waiting and this
 * session has not been handed it (roadmap R2).
 *
 * DELIVERED EXACTLY ONCE, and it is worth being precise about WHERE that is
 * enforced. Across SESSIONS it is the hub: it excludes any answer some
 * session of this developer already carries (`hint_deliveries`, the durable
 * store). Within THIS session it is `rememberHintDelivery`'s check-and-set under
 * the state lock — the same first-writer-wins claim every hint delivery
 * makes, and unremembered means unemitted. The seen-set filter below is
 * neither of those: it is a cheap PRE-CHECK that saves a pointless spool
 * append on every later prompt of a session whose flush has not reached the
 * hub yet. Removing it costs spool churn, not the guarantee — which is why
 * the mutation that guards this path breaks the echo hash instead.
 *
 * SOLICITED SUBSTANCE OUTRANKS AN UNSOLICITED POINTER, and the ordering is
 * the product decision, not an implementation detail: this developer asked a
 * question and is waiting for it; a teammate pointer they never asked for can
 * wait one prompt. Both spend the same hint slot, so an answer never widens
 * the budget — it only wins the slot.
 */
const selectAnswer = (
  answers: readonly AnsweredQuestion[],
  seenRefIds: readonly string[],
): AnsweredQuestion | undefined => {
  const seen = new Set(seenRefIds);
  return answers.find((answer) => !seen.has(answer.claimId));
};

/**
 * The first author's notice (landed changes, step 4) with a commit this
 * session has not shown, cut to those commits: a notice the briefing already
 * told is not told again before the hub has heard it was. A pre-check, like
 * selectAnswer's; the claim in rememberLandedNoticeDelivery is the guarantee.
 */
const selectNotice = (
  notices: readonly LandedNotice[],
  shownIds: readonly string[],
): LandedNotice | undefined => {
  const shown = new Set(shownIds);
  return notices
    .map((notice) => ({ ...notice, commits: notice.commits.filter((commit) => !shown.has(commit.id)) }))
    .find((notice) => notice.commits.length > 0);
};

/** What joins a long prompt's terms on the wire. */
const QUERY_TERM_JOIN = " ";

/**
 * THE QUERY OF A LONG PROMPT (hold-out review round 3, M7; round 4, H1): a
 * prompt the hub's route cap cannot carry whole goes as the RANKED TERMS OF
 * ALL OF IT — the content words of every clause that is no command to the
 * session, topical words first (@crosscheck/schema promptTerms().ranked) —
 * joined by spaces and cut between terms at MAX_SEARCH_QUERY_CHARS. The hub
 * only ever counts terms, so nothing it reads is lost; what the round-3 head
 * and tail lost was the middle — K094 of the round-4 hold-out, a 3 137-
 * character report whose "utc", "scheduler", "renewal" and "unique
 * constraint" sat past the head and before the tail.
 */
const queryOf = (text: string, ranked: readonly string[]): string =>
  text.length <= MAX_SEARCH_QUERY_CHARS
    ? text
    : [...new Set([...pathTokensOf(text), ...ranked])].reduce((query, term) => {
        const longer = query.length === 0 ? term : `${query}${QUERY_TERM_JOIN}${term}`;
        return longer.length <= MAX_SEARCH_QUERY_CHARS ? longer : query;
      }, "");

/** A path or a file name as written, quotes and sentence marks off its ends: "src/auth/refresh.ts". */
const PATH_TOKEN = /^[\p{L}\p{N}_-]+(?:[./][\p{L}\p{N}_-]+)+$/u;

/**
 * The path-shaped words of a long prompt, whole and first (round 4, H1): the
 * hub's exact tier matches a target on a whole whitespace token, and its
 * terms split "src/auth/refresh.ts" into words, so the path travels as
 * written in front of the terms.
 */
const pathTokensOf = (text: string): readonly string[] =>
  text
    .split(/\s+/u)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((word) => PATH_TOKEN.test(word) && /\p{L}/u.test(word));

/**
 * The counters a turn the prompt path stood down on is booked under (M7) —
 * and, after the call, a call the hub answered that ended in no hint (L5).
 */
type StoodDownCounter = "flooredPromptCount" | "harnessTurnCount" | "quietCallCount";

/**
 * One more turn stood down on — the count and nothing else. Best effort, one
 * bounded write: no state file, or a busy lock, loses the count, never the
 * silence it counts.
 */
const bookStoodDown = (input: SelectAndRenderHintInput, counter: StoodDownCounter): Promise<boolean> =>
  updateSessionState(input.home, input.hostSessionKey, (fresh) => ({ ...fresh, [counter]: fresh[counter] + 1 }));

/** Whose intent the session held when it was handed something (M7). */
const matchingOf = (state: SessionState, matchedOn: DeliveryMatching["matchedOn"]): DeliveryMatching => ({
  matchedOn,
  intentProvenance: state.workContextIntentProvenance ?? null,
});

/**
 * The whole prompt-time pipeline; returns the rendered hint or "" (silence).
 * Every branch that cannot prove a hint is worth injecting returns "".
 */
export const selectAndRenderHint = async (
  input: SelectAndRenderHintInput,
): Promise<string> => {
  // A TURN THE HARNESS WROTE — a background task's notification, another
  // agent's or session's message, delivered as a user turn — is nobody's
  // prompt: no call, not even the intent in its place. Around a wrapper,
  // only the human text is a query (@crosscheck/schema harness-turn.ts).
  if (isHarnessTurn(input.prompt)) {
    await bookStoodDown(input, "harnessTurnCount");
    return "";
  }
  // ONE CLASSIFICATION per hook (round 3, L4): the caller's, or this one.
  const { human: humanText, terms } = input.classified ?? classifyPrompt(input.prompt);
  // A CONTENT-FREE PROMPT is not a query, and it is not SENT: every word a
  // function word or one that steers the session — "mache weiter", "please
  // continue, the limit was reset" — decided here by the hub's own rule
  // (@crosscheck/schema prompt-terms.ts), so a hub too old to know it is
  // never asked (review 1006b, L5). Whether a prompt WITH content matches a
  // teammate's work is the hub's call — only the hub holds their words.
  // AND A PROMPT THAT CARRIES THE SESSION ON IS NOT ASKED ABOUT (round 4,
  // C1): "cache fix is merged, next" reports on the session's own work and
  // hands it back — no call, whatever else it says.
  const promptQuery = terms.isContentFree || terms.hasContinuation ? "" : queryOf(humanText, terms.ranked);
  // NOTHING STANDS IN for a prompt that said nothing — not the session's
  // intent either (owner decision, review 1006b M6): no call at all, and the
  // turn is counted as floored whatever the session's budget (M7).
  if (promptQuery.length === 0) {
    await bookStoodDown(input, "flooredPromptCount");
    return "";
  }
  // SECRET GATE — the capture scan's sibling, on the QUERY. The prompt goes
  // on the wire as a GET string (into a shared hub's request path and access
  // logs), and on the Cursor connector it is captured tool output — a failing
  // `curl -H "Authorization: …"`, a dumped DSN, a printed JWT — exactly the
  // text class capture/secret-scan.ts refuses to spool. Same rule here: a
  // hit means drop the whole attempt, never redact-and-send. Defense in
  // depth for the prompt-text connectors too (a pasted credential).
  if (containsSecret(input.prompt)) {
    return "";
  }
  // No state file means no session was registered here: no session to
  // attribute a delivery to and no seen-set to hold the cap — silence, not
  // recovery (a hint is never worth a register).
  const state = await readSessionState(input.home, input.hostSessionKey);
  if (state === null) {
    return "";
  }
  if (state.deliveredHintRefs.length >= MAX_HINTS_PER_SESSION) {
    return "";
  }
  const result = await getHintCandidates(input.hub, {
    query: promptQuery,
    repo: input.repoId,
  });
  if (!result.ok) {
    return "";
  }
  // THE QUERY SENT is what an old hub's candidates are recounted on, by the
  // hub's own rule (round 3, follow-up): a prompt past the route's cap went
  // as its window, so it is the window that is classified then.
  const sent = promptQuery === humanText ? terms : promptTerms(promptQuery);
  const text = await hintFromAnswer(input, state, result.data, sent);
  // A CALL THE HUB ANSWERED THAT ENDED IN NO HINT is counted, and only
  // counted (hold-out review round 3, L5): with the turns stood down on, it
  // says whether a quiet session was never asked or asked and matched nothing.
  if (text.length === 0) {
    await bookStoodDown(input, "quietCallCount");
  }
  return text;
};

/** What the hub's answer to THIS prompt yields: one hint, or "" (silence). */
const hintFromAnswer = async (
  input: SelectAndRenderHintInput,
  state: SessionState,
  answered: HintCandidatesResult,
  terms: PromptTerms,
): Promise<string> => {
  // #20 observability: book that the hub returned candidates for THIS repo, so
  // `doctor` can tell "no hint ever fired because nothing matched" apart from
  // "a match was possible but the selector chose silence". Only on a non-empty
  // result — a no-match prompt books its quiet call instead (L5), so either
  // way one monotonic counter, one bounded write inside the 800 ms budget.
  if (answered.candidates.length > 0) {
    await updateSessionState(input.home, input.hostSessionKey, (fresh) => ({
      ...fresh,
      hintCandidatesSeen: fresh.hintCandidatesSeen + answered.candidates.length,
    }));
  }
  // Room for the lines appended after whichever hint goes out — the answer's
  // the same as a teammate's (review 1006b, L3).
  const reserveChars = hintTrailerReserve(answered.coverage, input.now);
  // The solicited pass FIRST — see selectAnswer for why it outranks.
  const answer = selectAnswer(answered.answers, state.deliveredHintRefs);
  if (answer !== undefined) {
    const text = renderAnswerHint(answer, input.now, reserveChars);
    if (text.length > 0) {
      const delivery: Delivery = {
        refKind: "claim",
        refId: answer.claimId,
        channel: "prompt_hint",
        // Hashed like every other injected body: an answer that came back to
        // this session must not be re-published as its own observation
        // (hints/echo.ts, the echo-loop exclusion).
        bodyHash: hintBodyHash(answer.claimBody),
        text,
        // A question this developer asked, never a pointer they did not (M7).
        matching: matchingOf(state, "answer"),
      };
      // The note rides the EMITTED text, never the remembered one: the
      // delivery record is what dedup and the echo-loop exclusion hash, and a
      // caveat that changed from day to day would defeat both.
      return (await rememberHintDelivery(input, state, delivery, true))
        ? withCoverageNote(text, answered.coverage, input.now)
        : "";
    }
  }
  // ADDRESSED NEWS NEXT (landed changes, step 4): a teammate's edit stopped
  // at this developer's own landed change. After an answer — they asked for
  // that one and are waiting — and before a pointer they never asked for,
  // and in the same one slot either would spend.
  const spareMs = input.tellsNotices === true ? input.spareMs : undefined;
  const notice =
    spareMs === undefined || spareMs() < LANDED_NOTICE_MIN_SPARE_MS
      ? undefined
      : selectNotice(answered.notices, state.shownLandedNoticeIds);
  const told = notice === undefined ? null : renderLandedNoticeHint(notice, input.now);
  const firstCommit = told?.commitIds[0];
  if (spareMs !== undefined && told !== null && firstCommit !== undefined) {
    return (await rememberLandedNoticeDelivery(
      input,
      state,
      { slotRef: firstCommit, commitIds: told.commitIds },
      spareMs,
    ))
      ? told.text
      : "";
  }
  const selection = selectHint({
    // Briefing solved pointers join the seen-set — the same tree must not be
    // re-pointed — but NOT deliveredCount: they were the briefing's budget,
    // and spending prompt-hint slots on them would starve real hints. A
    // solved tree's evidence-backed claims stay deliverable as substance
    // (the seen-set suppresses pointers to a seen context, never unseen
    // claims inside it — hints/select.ts).
    candidates: answered.candidates,
    seenRefIds: [...state.deliveredHintRefs, ...state.briefingSolvedRefs],
    deliveredCount: state.deliveredHintRefs.length,
    selfDeveloperId: state.developerId,
    // What an old hub's candidates are recounted on (hold-out review, H4).
    promptTerms: terms.ranked,
    promptTopicalTerms: terms.topical,
  });
  const delivery = await renderSelection(
    {
      repoRoot: input.repoRoot,
      now: input.now,
      intentProvenance: state.workContextIntentProvenance ?? null,
      reserveChars,
      substanceChannel: substanceChannelOf(answered.deliveryChannels),
    },
    selection,
  );
  if (delivery === null || delivery.text.length === 0) {
    return "";
  }
  // Unremembered means unemitted — the honest direction: a state write that
  // fails (no file, busy lock) costs one hint slot, never a repeat delivery.
  const remembered = await rememberHintDelivery(input, state, delivery);
  if (!remembered) {
    return "";
  }
  return withCoverageNote(delivery.text, answered.coverage, input.now);
};
