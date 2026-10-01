import type { Context } from "hono";

import type { Db } from "./db/client.ts";
import type { Embedder } from "./services/embedder.ts";

/** Injected time source — pure logic never reads the system clock directly. */
export type Clock = () => Date;

export interface AuthedDeveloper {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

export type AppEnv = {
  Variables: {
    developer: AuthedDeveloper;
    /** The signed /ui session cookie value — set by the UI session
     * middleware, consumed by the CSRF derivation (ui/session.ts). */
    uiSessionToken: string;
  };
};

export interface AppDeps {
  readonly db: Db;
  readonly now: Clock;
  readonly adminToken: string | null;
  /**
   * Writes CI runs, and nothing else. NOT the admin token: that one also
   * flips `pin_policy` and `suspect_attribution`, and putting it in a CI
   * secret widens its blast radius to every fork-adjacent workflow mistake.
   * Null = no reporter is configured and the write route refuses.
   */
  readonly ciToken: string | null;
  /** Null = keyless install: the vector tier is silently absent (DESIGN.md §6). */
  readonly embedder: Embedder | null;
  /**
   * Test seam for the embed deadline — omitted (production, always) means
   * SEARCH_EMBED_DEADLINE_MS; services/search.ts SearchDeps says why.
   */
  readonly embedDeadlineMs?: number;
  /** HMAC secret for /ui session cookies — ui/session.ts documents rotation. */
  readonly uiSessionSecret: string;
  /**
   * The origins a person may use a passkey at (1.0 spec 04a §7), already
   * checked by `parseWebAuthnOrigins`. Empty = no origin: the passkey pages
   * say so rather than offering a ceremony every browser would refuse.
   */
  readonly webauthnOrigins: readonly string[];
  /**
   * The TCP peer of a request, null when unknown (http/peer.ts). Production
   * reads Bun's `requestIP`; the test harness says loopback unless a test
   * says otherwise, since `app.request` has no socket to read.
   */
  readonly peerAddress: (c: Context<AppEnv>) => string | null;
}