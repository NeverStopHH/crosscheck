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
  /** Null = keyless install: the vector tier is silently absent (DESIGN.md §6). */
  readonly embedder: Embedder | null;
  /** HMAC secret for /ui session cookies — ui/session.ts documents rotation. */
  readonly uiSessionSecret: string;
}