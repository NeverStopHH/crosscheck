/**
 * THE FIRST IMPORT OF EVERY CROSSCHECK ENTRY (runtime-isolation.ts
 * `ensureCleanRuntime`; review round 2, N2).
 *
 * An ES module evaluates its imports in order before its own body, so an
 * entry whose FIRST import is this file runs the check before any module that
 * reads config, a key or the environment. Entries: `cli/src/bin/crosscheck.ts`
 * and every `*worker-entry.ts`; runtime-isolation.test.ts holds them to it.
 */
import { ensureCleanRuntime } from "./runtime-isolation.ts";

ensureCleanRuntime();
