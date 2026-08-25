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
 * the state read and the cap check are local and run first, so a session
 * that has spent its budget makes no hub call at all. One bounded GET
 * follows, against an indexed equality lookup on the fingerprint.
 *
 * NO SECRET GATE HERE, because there is nothing new to gate: the only value
 * that goes on the wire is the fingerprint, and `fingerprint()` already
 * refuses to produce one from text that contains a secret (drop, never a
 * redacted derivative — capture/fingerprint.ts). The failure TEXT never
 * leaves this machine on this path; the prompt-style hint that does send
 * text has its own gate in flows/hint.ts.
 */
import { MAX_HINTS_PER_SESSION } from "../constants.ts";
import { getSolvedMatchesForFingerprint } from "../http/hub.ts";
import type { HubContext } from "../http/hub.ts";
import { rememberHintDelivery } from "../hints/delivery.ts";
import { renderSolvedHint } from "../hints/render.ts";
import { readSessionState } from "../state/session-state.ts";

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
  const match = result.data.find((entry) => !seen.has(entry.workContextId));
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
