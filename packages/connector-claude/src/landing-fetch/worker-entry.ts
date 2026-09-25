#!/usr/bin/env bun
/**
 * The detached landing-fetch worker's OWN executable entry — started by the
 * hooks (hooks/landing-fetch.ts), never by a person; the summarizer's
 * worker-entry.ts states why an entry lives beside the hooks that start it
 * rather than in the CLI package. Input is named by flags (`--root`), and
 * the exit code is the worker's own (nothing downstream reads it).
 */
import { runLandingFetchWorker } from "@crosscheck/connector-core/landed-changes/fetch-worker.ts";

process.exit(await runLandingFetchWorker(process.argv.slice(2), process.env));
