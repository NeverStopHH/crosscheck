#!/usr/bin/env bun
/**
 * The derived-intent worker's ACP entry — spawned by the capture engine's
 * session/prompt dispatch, never by a person.
 *
 * The WORKER is core's (derive/intent/worker.ts): what it does with a parked
 * prompt is host-independent, and a second copy would be a second set of
 * gates to keep in step. The ENTRY is this package's because the trigger
 * resolves it as a filesystem path relative to its own directory, and a
 * proxy that reached across into another package's tree would break the
 * moment that package moved — the Stop hook's rule, third host.
 */
import { runIntentWorker } from "@crosscheck/connector-core/derive/intent/worker.ts";

process.exit(await runIntentWorker(process.argv.slice(2), process.env));
