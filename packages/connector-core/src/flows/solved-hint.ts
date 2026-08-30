/**
 * `selectAndRenderSolvedHint` — collective memory delivered at the moment
 * the symptom appears (VISION.md §1).
 *
 * WHY A SECOND DELIVERY MOMENT EXISTS AT ALL. The SessionStart briefing
 * already carries "previously solved" entries, but it is assembled before
 * the session has failed at anything: it can only match on what OTHER work
 * on the repo is touching, plus this developer's declared intent. The
 * strongest signal this product has — an error fingerprint, content identity
 * with a failure somebody already diagnosed — does not exist yet at that
 * point. It appears exactly when a tool fails, and on a long agent turn the
 * next SessionStart can be an hour of re-deriving an answer the team owns.
 *
 * IT SPENDS THE ORDINARY HINT BUDGET, and that is the whole noise story: the
 * session cap (MAX_HINTS_PER_SESSION) is checked before the hub call and
 * claimed after it through `rememberHintDelivery`, the same locked
 * check-and-set the prompt path uses — so a failure storm inside one session
 * cannot produce a stream of these, two hooks racing one failure produce at
 * most one, and a tree already pointed at (by the briefing or by an earlier
 * hint) is silent rather than repeated.
 *
 * ZERO COST WHEN THERE IS NOTHING TO SAY, and the ordering is deliberate:
 * everything local runs first, so a session with nothing to gain makes no
 * hub call at all. Two local gates, and the second is the one that matters
 * on a retry loop. The session CAP only moves when a hint was actually
 * DELIVERED, so on the common paths — the hub holds nothing, or it holds a
 * tree this session was already shown — the cap is never reached and every
 * repeat of one failure used to buy another GET. Measured through the real
 * hook: 40 identical `bun test` failures produced 40 probes of ONE
 * fingerprint against a hub holding nothing, and 4475 ms of agent-turn
 * latency across 10 of them against a hub that never answered — the case a
 * degraded hub is least able to absorb. So a fingerprint is asked about ONCE
 * per session (`probedFingerprints`, the withTripwireAsked shape), claimed
 * under the state lock BEFORE the call so two hooks racing one failure ask
 * once between them. What that costs is stated rather than hidden: a
 * fingerprint whose answer only appears mid-session — a teammate solving it
 * while this session runs — is not asked about again until the next session.
 * One bounded GET follows, against an indexed equality lookup.
 *
 * NO SECRET GATE HERE, because there is nothing new to gate: the only value
 * that goes on the wire is the fingerprint, and `fingerprint()` already
 * refuses to produce one from text that contains a secret (drop, never a
 * redacted derivative — capture/fingerprint.ts). The failure TEXT never
 * leaves this machine on this path; the prompt-style hint that does send
 * text has its own gate in flows/hint.ts.
 */
import { MAX_HINTS_PER_SESSION } from "../constants.ts";
import { SUBSTANCE_MATCH_KIND } from "../briefing/render.ts";
import { getSolvedMatchesForFingerprint } from "../http/hub.ts";
import type { HubContext } from "../http/hub.ts";
import { rememberHintDelivery } from "../hints/delivery.ts";
import { renderSolvedHint } from "../hints/render.ts";
import {
  readSessionState,
  updateSessionState,
  withProbedFingerprint,
} from "../state/session-state.ts";

export interface SelectAndRenderSolvedHintInput {
  readonly home: string;
  readonly repoKey: string;
  readonly hub: HubContext;
  /** The host's own id for the session — the state file key. */
  readonly hostSessionKey: string;
  readonly repoId: string;
  readonly agentKind: string;
  /** The fingerprint the failure just produced; never the failure text. */
  readonly fingerprint: string;
  readonly now: Date;
}

/** The rendered hint, or "" (silence) — every doubtful branch returns "". */
export const selectAndRenderSolvedHint = async (
  input: SelectAndRenderSolvedHintInput,
): Promise<string> => {
  // No state file means no session was registered here: nothing to attribute
  // a delivery to and no seen-set to hold the cap — silence, not recovery.
  const state = await readSessionState(input.home, input.hostSessionKey);
  if (state === null) {
    return "";
  }
  if (state.deliveredHintRefs.length >= MAX_HINTS_PER_SESSION) {
    return "";
  }
  // REDUNDANT WITH THE CHECK-AND-SET BELOW, and recorded so it is not
  // re-reported as a gap: the transform refuses an already-probed
  // fingerprint on its own, so deleting these three lines reddens NOTHING.
  // Measured by deleting them here on macOS 26 arm64: solved-hint-flow.test.ts
  // printed 11 pass / 0 fail and the whole of packages/connector-core printed
  // 845 pass / 0 fail. Trust the shape over those totals, which age on every
  // test anyone adds. It stays because a retry loop reaches this line dozens
  // of times a minute and the fast path costs one comparison where the slow
  // one takes the state lock and re-reads the file — the same trade, and the
  // same disclosure, as the empty-string guard in briefing/sanitize.ts.
  if (state.probedFingerprints.includes(input.fingerprint)) {
    return "";
  }
  // CLAIM THE QUESTION, under the state lock, before spending anything on
  // it: the lockless read above is what a racing sibling hook also passed
  // (Cursor fires two signals for one failure), so the check-and-set is what
  // makes "asked once" true rather than "asked twice, quickly". THIS is the
  // guard the mutation entry names. A state write that fails costs this
  // fingerprint its probe, never a second one.
  const claimed = await updateSessionState(input.home, input.hostSessionKey, (fresh) =>
    fresh.probedFingerprints.includes(input.fingerprint)
      ? null
      : withProbedFingerprint(fresh, input.fingerprint),
  );
  if (!claimed) {
    return "";
  }
  const result = await getSolvedMatchesForFingerprint(
    input.hub,
    input.repoId,
    input.fingerprint,
  );
  if (!result.ok) {
    return "";
  }
  // The briefing's solved pointers join the seen-set exactly as they do on
  // the prompt path: the same tree must not be pointed at twice in one
  // session, whichever surface got there first.
  const seen = new Set([
    ...state.deliveredHintRefs,
    ...state.briefingSolvedRefs,
  ]);
  // THE KIND THE HEADER NAMES, required here and not only at render time.
  // `renderSolvedHint` refuses a weaker kind on its own, but a `find` that
  // picked the first unseen row and left the refusal to the renderer would
  // go silent whenever an older hub put a file-matched row above the
  // fingerprint one — the answer sitting one row down, dropped by the guard
  // meant to protect it. Filtering here picks the row the header can vouch
  // for, wherever in the page it arrived.
  const match = result.data.find(
    (entry) =>
      entry.matchedTargetKind === SUBSTANCE_MATCH_KIND &&
      !seen.has(entry.workContextId),
  );
  if (match === undefined) {
    return "";
  }
  const text = renderSolvedHint(match, input.repoId, input.now);
  if (text.length === 0) {
    return "";
  }
  // Unremembered means unemitted — a state write that fails costs one hint
  // slot, never a repeat delivery. `bodyHash` stays null even when the line
  // quotes a root cause: the echo-loop exclusion is about text THIS session
  // might re-publish as its own observation, and a solved tree's claim is
  // already published, by somebody else, under its own id.
  const remembered = await rememberHintDelivery(input, state, {
    refKind: "work_context",
    refId: match.workContextId,
    bodyHash: null,
  });
  return remembered ? text : "";
};
