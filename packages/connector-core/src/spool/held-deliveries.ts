/**
 * A DELIVERY THIS MACHINE STILL HOLDS (1.0 spec 07 §13.10 #14, §13.11).
 *
 * A prompt hint, a tripwire ask or a briefing pointer books its delivery into
 * the spool, and the spool is sent after the next tool runs — a denied edit
 * runs no after-tool hook at all. So an outcome or a label recorded right
 * after the hint names a delivery the hub has not seen yet, and the hub's
 * honest answer, "no hint with that id reached you", is false from where the
 * reader sits: it reached them; it has not reached the hub.
 *
 * POST FIRST (review, round 3). The hub's answer stands unless it does not
 * know a ref this machine still holds; only then are held records sent, and
 * the call made once more. They are sent only in the name of the ONE live
 * session of this checkout, and only that session's own spool: never a
 * guessed session when several are live (no FOREIGN_SESSION_DELIVERY), and
 * never a session that went silent (no reviving a reaped one). When nothing
 * can be sent, the answer says why — never "it never reached you".
 */
import { PULLED_DELIVERY_CHANNEL } from "@crosscheck/schema";

import { realpathBestEffort, sessionSlug } from "../config/paths.ts";
import type { RepoIdentity } from "../git/repo-identity.ts";
import type { HubContext, HubResult } from "../http/client.ts";
import { NOISE_MARK_WINDOW_MINUTES } from "../constants.ts";
import { getMarkCandidates } from "../http/pilot.ts";
import type { MarkCandidate, MarkCandidates } from "../http/pilot.ts";
import { readLiveSessionStates } from "../state/session-state.ts";
import { flushSpool } from "./flush.ts";
import type { FlushInput } from "./flush.ts";
import { readSessionSpool, readSpoolLines } from "./files.ts";

const HINT_DELIVERY_KIND = "hint_delivery";
const MS_PER_MINUTE = 60_000;

/** Who may send the held records: the one live session of this checkout, or why nobody may. */
export type SenderLookup =
  | { readonly kind: "live"; readonly sender: FlushInput & { readonly onlySlug: string } }
  /** Several live sessions here, none told apart by the checkout — guessing would file records under the wrong one. */
  | { readonly kind: "ambiguous" }
  /** No live session of this repo here: a silent one is not revived to send. */
  | { readonly kind: "no_live_session" };

type LiveState = Awaited<ReturnType<typeof readLiveSessionStates>>["states"][number];

/** The live sessions of this repo that could be sending for this checkout: those on its root, or all when none is. */
const sendingSessions = async (hub: HubContext, identity: RepoIdentity): Promise<readonly LiveState[]> => {
  const scan = await readLiveSessionStates(hub.home, hub.hubUrl, identity.repoId, hub.now());
  const here = await realpathBestEffort(identity.root);
  const roots = await Promise.all(scan.states.map((state) => realpathBestEffort(state.repoRoot)));
  const onThisRoot = scan.states.filter((_state, index) => roots[index] === here);
  return onThisRoot.length > 0 ? onThisRoot : scan.states;
};

/**
 * THE SENDER, NEVER GUESSED: among the live sessions of this repo, the one
 * on this checkout's root — or the only one, when none is on it.
 */
export const findSender = async (hub: HubContext, identity: RepoIdentity): Promise<SenderLookup> => {
  const candidates = await sendingSessions(hub, identity);
  const [only] = candidates;
  if (only === undefined) {
    return { kind: "no_live_session" };
  }
  if (candidates.length > 1) {
    return { kind: "ambiguous" };
  }
  return {
    kind: "live",
    sender: {
      sessionId: only.crosscheckSessionId,
      developerId: only.developerId,
      onlySlug: sessionSlug(only.hostSessionKey),
    },
  };
};

const deliveryRefs = (line: string): readonly string[] => {
  try {
    const parsed = JSON.parse(line) as { kind?: unknown; body?: { id?: unknown; refId?: unknown } };
    if (parsed.kind !== HINT_DELIVERY_KIND) {
      return [];
    }
    return [parsed.body?.id, parsed.body?.refId].filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
};

/**
 * Whether this machine's spool still holds an unsent delivery of `ref` — the
 * id the hint printed or the delivery's own id. Always a named ref: "any
 * recent one" is answered from the live sessions' own spools, as candidates
 * (`withHeldCandidates`), never by a scan of every session's (review LOW).
 */
export const holdsUnsentDelivery = async (hub: HubContext, ref: string): Promise<boolean> =>
  (await readSpoolLines(hub.home, hub.repoKey)).some((line) => deliveryRefs(line).includes(ref));

const isString = (value: unknown): value is string => typeof value === "string";

/** A held line as the candidate the hub would list for it — unasked deliveries only, as the hub lists them. */
const heldCandidateOf = (line: string): MarkCandidate | null => {
  try {
    const parsed = JSON.parse(line) as { kind?: unknown; body?: Record<string, unknown> };
    const { id, sessionId, channel, refKind, refId, deliveredAt } = parsed.body ?? {};
    if (
      parsed.kind !== HINT_DELIVERY_KIND ||
      !isString(id) ||
      !isString(sessionId) ||
      !isString(channel) ||
      !isString(refKind) ||
      !isString(refId) ||
      !isString(deliveredAt) ||
      channel === PULLED_DELIVERY_CHANNEL
    ) {
      return null;
    }
    return { id, sessionId, channel, refKind, refId, deliveredAt };
  } catch {
    return null;
  }
};

/** Newest delivery first, then id — the hub's own order for candidates. */
const newestFirst = (a: MarkCandidate, b: MarkCandidate): number =>
  Date.parse(b.deliveredAt) - Date.parse(a.deliveredAt) || a.id.localeCompare(b.id);

/** The unasked deliveries still held in these live sessions' OWN spools, newest first. */
const heldCandidates = async (hub: HubContext, sessions: readonly LiveState[]): Promise<readonly MarkCandidate[]> => {
  const spools = await Promise.all(
    sessions.map((state) => readSessionSpool(hub.home, hub.repoKey, sessionSlug(state.hostSessionKey))),
  );
  return spools
    .flatMap((spool) => spool.lines)
    .map(heldCandidateOf)
    .filter((candidate): candidate is MarkCandidate => candidate !== null)
    .sort(newestFirst);
};

/**
 * ONE CANDIDATE PER POINTER (07 §13.10, M4): a prompt hint and a tripwire ask
 * about one ref in one session are one intervention, so they are offered
 * once — as the pointer's newest delivery — and newest pointer first.
 */
export const onePerPointer = (candidates: readonly MarkCandidate[]): readonly MarkCandidate[] =>
  [...candidates]
    .sort(newestFirst)
    .filter(
      (candidate, index, sorted) =>
        sorted.findIndex((other) => other.sessionId === candidate.sessionId && other.refId === candidate.refId) === index,
    );

/**
 * HELD FIRST (07 §13.12, review H-A): the newest unasked delivery of `ref`
 * still held in the sending session's own spool — today's — or null. Posting
 * a word against that delivery's own id makes the hub's "unknown" send it
 * first; posting the ref would land the word on whatever older delivery of
 * it the hub already has (last week's), superseding a word said there.
 */
export const heldDeliveryIdOf = async (hub: HubContext, identity: RepoIdentity, ref: string): Promise<string | null> => {
  // round-5 LOW-3: inside the window the no-id candidates use — an hour-old line stuck in a spool is not today's
  const since = hub.now().getTime() - NOISE_MARK_WINDOW_MINUTES * MS_PER_MINUTE;
  const held = (await heldCandidates(hub, await sendingSessions(hub, identity))).filter(
    (candidate) => Date.parse(candidate.deliveredAt) >= since,
  );
  return held.find((candidate) => candidate.refId === ref || candidate.id === ref)?.id ?? null;
};

/**
 * THE SAME POINTER'S TWIN, ALREADY ON THE HUB (round-5 LOW-3). When a held
 * delivery cannot be sent now, a prompt hint or tripwire ask of the same ref
 * in the same session that the hub already has is the same intervention
 * (M4): a word on it covers the pointer. Null when the hub has none — never
 * another session's delivery of the ref, which is another pointer.
 */
const hubTwinOf = async (hub: HubContext, identity: RepoIdentity, heldId: string): Promise<string | null> => {
  const held = (await readSpoolLines(hub.home, hub.repoKey))
    .map(heldCandidateOf)
    .find((candidate) => candidate !== null && candidate.id === heldId);
  if (held === undefined || held === null) {
    return null;
  }
  const listed = await getMarkCandidates(hub, { repo: identity.repoId, sessions: [held.sessionId], ref: held.refId });
  if (!listed.ok) {
    return null;
  }
  return listed.data.candidates.find((candidate) => candidate.sessionId === held.sessionId && candidate.id !== heldId)?.id ?? null;
};

/**
 * NO ID: WHAT REACHED A LIVE SESSION HERE (07 §13.12, review H-A). The hub's
 * recent candidates and the deliveries those sessions still hold, one per
 * pointer, newest first — so a pointer still on this machine is never passed
 * over for an older one the hub already has, and a pointer's twins are one.
 */
export const withHeldCandidates = async (
  hub: HubContext,
  sessions: readonly LiveState[],
  fromHub: MarkCandidates,
  windowMinutes: number,
): Promise<MarkCandidates> => {
  const since = hub.now().getTime() - windowMinutes * MS_PER_MINUTE;
  const held = (await heldCandidates(hub, sessions)).filter((candidate) => Date.parse(candidate.deliveredAt) >= since);
  return { candidates: [...onePerPointer([...held, ...fromHub.candidates])], more: fromHub.more };
};

/** Why a held delivery could not be counted on: not sent in time, or nobody may send it. */
export type HeldWhy = "unsent" | "ambiguous" | "no_live_session";

export type HeldAnswer<T> =
  | { readonly kind: "answered"; readonly result: HubResult<T> }
  | { readonly kind: "held"; readonly why: HeldWhy };

export interface HeldRetry<T> {
  readonly hub: HubContext;
  readonly identity: RepoIdentity;
  /** The ref or delivery id that was posted — "any recent one" is chosen before, from candidates. */
  readonly ref: string;
  readonly budgetMs: number;
  /** Makes the call about one ref or delivery id: the one posted, or the pointer's twin on the hub (LOW-3). */
  readonly call: (ref: string) => Promise<HubResult<T>>;
  /** True when the hub's answer is "I know no such delivery of yours". */
  readonly isUnknown: (result: HubResult<T>) => boolean;
}

const stillHeld = async <T>(retry: HeldRetry<T>, result: HubResult<T>): Promise<boolean> =>
  retry.isUnknown(result) && (await holdsUnsentDelivery(retry.hub, retry.ref));

/**
 * The hub's first answer, unless it does not know a ref this machine still
 * holds: then the one live session here sends its own held records, bounded,
 * and the call is made once more. A delivery still held after that — or one
 * nobody here may send — is answered as held, with why.
 */
export const answerAfterSendingHeld = async <T>(retry: HeldRetry<T>, first: HubResult<T>): Promise<HeldAnswer<T>> => {
  if (!(await stillHeld(retry, first))) {
    return { kind: "answered", result: first };
  }
  const lookup = await findSender(retry.hub, retry.identity);
  if (lookup.kind !== "live") {
    return { kind: "held", why: lookup.kind };
  }
  // THE ONE DRAIN PATH, ON PURPOSE: the public flushSpool with `onlySlug`, never a
  // second sender of its own. fix/resumed-session-rejected rewrites flush.ts (held
  // and unregistered lives); going through flushSpool is what makes that branch's
  // hold rule apply to this outcome-triggered send too once the two are merged.
  await flushSpool(retry.hub, lookup.sender, retry.budgetMs);
  const again = await retry.call(retry.ref);
  if (!(await stillHeld(retry, again))) {
    return { kind: "answered", result: again };
  }
  // round-5 LOW-3: the send failed or overran, but the same pointer's twin may already be on the hub
  const twin = await hubTwinOf(retry.hub, retry.identity, retry.ref);
  return twin === null ? { kind: "held", why: "unsent" } : { kind: "answered", result: await retry.call(twin) };
};
