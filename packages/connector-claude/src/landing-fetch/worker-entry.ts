#!/usr/bin/env bun
/**
 * The detached landing-fetch worker's OWN executable entry — started by the
 * hooks (hooks/landing-fetch.ts), never by a person; the summarizer's
 * worker-entry.ts states why an entry lives beside the hooks that start it
 * rather than in the CLI package. Input is named by flags (`--root`). After a
 * call abandoned at its deadline it ends its own process group, so nothing
 * that call left behind outlives it (core fetch-worker.ts).
 */
import {
  EXIT_ABANDONED,
  endAbandonedDescendants,
  runLandingFetchWorker,
} from "@crosscheck/connector-core/landed-changes/fetch-worker.ts";

const code = await runLandingFetchWorker(process.argv.slice(2), process.env);
if (code === EXIT_ABANDONED) {
  await endAbandonedDescendants();
}
process.exit(code);
