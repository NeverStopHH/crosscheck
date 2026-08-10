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
  };
};

export interface AppDeps {
  readonly db: Db;
  readonly now: Clock;
  readonly adminToken: string | null;
  /** Null = keyless install: the vector tier is silently absent (DESIGN.md §6). */
  readonly embedder: Embedder | null;
}