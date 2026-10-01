/**
 * WHO IS ON THE OTHER END OF THE SOCKET — for the one rule that needs it
 * (1.0 spec 04a §7): a passkey ceremony at a `localhost` origin is only
 * accepted from a loopback peer.
 *
 * `http://localhost:<port>` names a different machine for every browser that
 * types it, and a passkey created there syncs to the person's other devices.
 * Without this rule an agent on ANOTHER of those devices could serve its own
 * page at its own localhost, collect the person's touch for its own terms, and
 * post the assertion to the hub across the tailnet with that same Origin.
 */
import type { Context } from "hono";

import type { AppEnv } from "../types.ts";

/** What Bun passes to `fetch` as its second argument, as far as this module reads it. */
interface BunServerLike {
  readonly requestIP?: (request: Request) => { readonly address: string } | null;
}

/**
 * The peer address Bun reports, or null when it reports none — under
 * `app.request` in tests, or behind something that is not Bun's server.
 * Null is UNKNOWN, and every caller treats unknown as not-loopback.
 */
export const bunPeerAddress = (c: Context<AppEnv>): string | null => {
  const server = c.env as BunServerLike | undefined;
  try {
    return server?.requestIP?.(c.req.raw)?.address ?? null;
  } catch {
    return null;
  }
};

/** 127.0.0.0/8, ::1, and the IPv4-mapped form a dual-stack socket reports. */
export const isLoopbackAddress = (address: string): boolean =>
  address === "::1" || /^127\./.test(address) || /^::ffff:127\./i.test(address);
