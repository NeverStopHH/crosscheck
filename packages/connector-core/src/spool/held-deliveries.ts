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
import { realpathBestEffort, sessionSlug } from "../config/paths.ts";
import type { RepoIdentity } from "../git/repo-identity.ts";
import type { HubContext, HubResult } from "../http/client.ts";
import { readLiveSessionStates } from "../state/session-state.ts";
import { flushSpool } from "./flush.ts";
import type { FlushInput } from "./flush.ts";
import { readSpoolLines } from "./files.ts";

const HINT_DELIVERY_KIND = "hint_delivery";

/** Who may send the held records: the one live session of this checkout, or why nobody may. */
export type SenderLookup =
  | { readonly kind: "live"; readonly sender: FlushInput & { readonly onlySlug: string } }
  /** Several live sessions here, none told apart by the checkout — guessing would file records under the wrong one. */
  | { readonly kind: "ambiguous" }
  /** No live session of this repo here: a silent one is not revived to send. */
  | { readonly kind: "no_live_session" };

/**
 * THE SENDER, NEVER GUESSED: among the live sessions of this repo, the one
 * on this checkout's root — or the only one, when none is on it.
 */
export const findSender = async (hub: HubContext, identity: RepoIdentity): Promise<SenderLookup> => {
  const scan = await readLiveSessionStates(hub.home, hub.hubUrl, identity.repoId, hub.now());
  const here = await realpathBestEffort(identity.root);
  const roots = await Promise.all(scan.states.map((state) => realpathBestEffort(state.repoRoot)));
  const onThisRoot = scan.states.filter((_state, index) => roots[index] === here);
  const candidates = onThisRoot.length > 0 ? onThisRoot : scan.states;
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
 * id the hint printed or the delivery's own id — or, with `ref` null, any
 * unsent delivery at all.
 */
export const holdsUnsentDelivery = async (hub: HubContext, ref: string | null): Promise<boolean> =>
  (await readSpoolLines(hub.home, hub.repoKey)).some((line) => {
    const refs = deliveryRefs(line);
    return ref === null ? refs.length > 0 : refs.includes(ref);
  });

/** Why a held delivery could not be counted on: not sent in time, or nobody may send it. */
export type HeldWhy = "unsent" | "ambiguous" | "no_live_session";

export type HeldAnswer<T> =
  | { readonly kind: "answered"; readonly result: HubResult<T> }
  | { readonly kind: "held"; readonly why: HeldWhy };

export interface HeldRetry<T> {
  readonly hub: HubContext;
  readonly identity: RepoIdentity;
  /** The hint's ref, or null for "any recent one". */
  readonly ref: string | null;
  readonly budgetMs: number;
  readonly call: () => Promise<HubResult<T>>;
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
  await flushSpool(retry.hub, lookup.sender, retry.budgetMs);
  const again = await retry.call();
  return (await stillHeld(retry, again)) ? { kind: "held", why: "unsent" } : { kind: "answered", result: again };
};
