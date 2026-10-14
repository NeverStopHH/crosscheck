/**
 * THE FIRST IMPORT OF EVERY CROSSCHECK ENTRY (clean-restart.ts
 * `ensureCleanRuntime`; review round 2, N2).
 *
 * An ES module evaluates its imports in order before its own body, so an
 * entry whose FIRST import is this file runs the check before any module that
 * reads config, a key or the environment. A process that restarted itself
 * awaits here for good, as the restarted one's supervisor: Bun evaluates
 * neither the entry's other imports nor its body behind a pending top-level
 * await (measured on 1.3.13). Entries: `cli/src/bin/crosscheck.ts` and every
 * `*worker-entry.ts`; runtime-isolation.test.ts holds them to it.
 */
import { ensureCleanRuntime } from "./clean-restart.ts";

await ensureCleanRuntime();
