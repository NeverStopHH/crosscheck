/**
 * THE NEXT TURN OF THE EVENT LOOP, where a request that arrived meanwhile is
 * read (review-2 round 9, M4). PGlite serves one statement at a time and
 * answers in microtasks, so a loop of statements that never yields reads no
 * request until it is done. A hub-wide pass — the receipts prune, the
 * skeleton backfill — yields after every statement, and a request waits out
 * one statement at most.
 */
export const yieldToRequests = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
