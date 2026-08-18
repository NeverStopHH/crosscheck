/**
 * Echo-loop exclusion (DESIGN.md §3, judge-mandated): content injected as a
 * teammate hint is marked so it can never be re-captured as the reader's own
 * independent observation — Robin's hypothesis must not come back as Nick's.
 *
 * The mark is a hash of the claim body under the SAME normalization the hub's
 * ingest dedup applies (trim, collapse whitespace, lowercase — see
 * normalizeClaimBody in packages/server/src/services/record-handlers.ts), so
 * "the same words" means the same thing on both sides. Stored in the session
 * state file, which is what survives hook process restarts.
 *
 * DETERMINISTIC v0, honestly bounded: a verbatim or whitespace/case-mangled
 * echo is caught; a paraphrase is not. The same limitation the ingest dedup
 * documents, accepted for the same reason — similarity matching is the
 * embedding tier's job, and the capture path must not depend on one existing.
 */

/** Mirror of the hub's ingest normalization — see the header for the source. */
export const normalizeHintBody = (body: string): string =>
  body.trim().replace(/\s+/g, " ").toLowerCase();

/** Same truncation discipline as FINGERPRINT_HASH_CHARS: 128 bits of SHA-256. */
const ECHO_HASH_CHARS = 32;

export const hintBodyHash = (body: string): string =>
  new Bun.CryptoHasher("sha256")
    .update(normalizeHintBody(body))
    .digest("hex")
    .slice(0, ECHO_HASH_CHARS);

/** Is this body a re-statement of something a hint delivered this session? */
export const isEchoOfDeliveredHint = (
  body: string,
  deliveredHintHashes: readonly string[],
): boolean => deliveredHintHashes.includes(hintBodyHash(body));
