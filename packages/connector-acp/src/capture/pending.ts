/**
 * The bounded pending-map (design §2.4): request id → (method, params), one
 * per direction, "the only protocol state the proxy keeps beyond per-session
 * capture state". A peer that never answers must cost fixed memory, so past
 * the cap the OLDEST entry is evicted and counted — its eventual response
 * then captures nothing, which is the fail-open direction (the response
 * bytes were forwarded verbatim regardless).
 */
import { ACP_MAX_PENDING_REQUESTS } from "../constants.ts";
import type { WireId } from "../wire/v1.ts";

export interface PendingRequest {
  readonly method: string;
  readonly params: unknown;
}

export interface PendingMap {
  put(id: WireId, entry: PendingRequest): void;
  /** Removes and returns the entry — a response consumes its request. */
  take(id: WireId): PendingRequest | null;
  size(): number;
  evictions(): number;
}

/** `1` (number) and `"1"` (string) are DISTINCT JSON-RPC ids. */
const keyFor = (id: WireId): string => `${typeof id}:${id}`;

export const createPendingMap = (
  cap: number = ACP_MAX_PENDING_REQUESTS,
): PendingMap => {
  /** Map iteration order is insertion order — FIFO eviction for free. */
  const entries = new Map<string, PendingRequest>();
  let evictions = 0;

  return {
    put(id, entry) {
      const key = keyFor(id);
      // Re-put refreshes: delete first so the entry moves to the tail.
      entries.delete(key);
      entries.set(key, entry);
      if (entries.size > cap) {
        const oldest = entries.keys().next();
        if (!oldest.done) {
          entries.delete(oldest.value);
          evictions += 1;
        }
      }
    },
    take(id) {
      const key = keyFor(id);
      const entry = entries.get(key);
      if (entry === undefined) {
        return null;
      }
      entries.delete(key);
      return entry;
    },
    size: () => entries.size,
    evictions: () => evictions,
  };
};
