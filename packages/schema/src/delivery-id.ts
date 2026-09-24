/**
 * A DELIVERY'S ID IS COMPUTED, NEVER CHOSEN — and the hub now checks that it
 * was (07 §3.1, corrected by adversarial review).
 *
 * The id is deterministic from (receiving session, ref) so a spool replay
 * re-sends the same primary key and the hub answers `duplicate`. Deterministic
 * also means COMPUTABLE by anybody who knows the two inputs, and both are
 * visible: a teammate's session id is on the presence board, and the ref is a
 * work-context id. Ingest used to check only that the posted `sessionId` was
 * the caller's, never that the id came from it — so a teammate could post
 * `hd(your session, ref)` under their own session first. The primary key then
 * dropped YOUR genuine delivery as a duplicate, `crosscheck noise` refused you
 * as `not_yours`, and the squatter's mark about your intervention stood.
 *
 * ONE DERIVATION, HERE, shared by the connector that mints the id and the hub
 * that checks it, so the two cannot drift apart.
 */

const HINT_DELIVERY_ID_HASH_CHARS = 32;

/** 128 bits of SHA-256 over (receiving session, ref): unique per the seen-set. */
export const hintDeliveryId = (
  receiverSessionId: string,
  refId: string,
): string =>
  `hd_${new Bun.CryptoHasher("sha256")
    .update(`${receiverSessionId}\n${refId}`)
    .digest("hex")
    .slice(0, HINT_DELIVERY_ID_HASH_CHARS)}`;

/**
 * A tripwire ask's delivery id — its own namespace, because the tripwire asks
 * per FILE whatever the briefing and the hint already showed, and one id would
 * make the hub keep whichever arrived first. `\n` cannot occur in a ref id, so
 * the namespaced input never equals a bare one.
 */
export const tripwireDeliveryId = (
  receiverSessionId: string,
  refId: string,
): string => hintDeliveryId(receiverSessionId, `${refId}\ntripwire`);

/** The id a delivery on this channel MUST carry. */
export const deliveryIdFor = (
  receiverSessionId: string,
  refId: string,
  channel: string,
): string =>
  channel === "tripwire"
    ? tripwireDeliveryId(receiverSessionId, refId)
    : hintDeliveryId(receiverSessionId, refId);
