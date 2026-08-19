#!/usr/bin/env bun
/**
 * The detached Tier-1 worker's OWN executable entry — spawned by the Stop
 * hook (hooks/stop.ts), never by a person. Before Block 8 the hook spawned
 * the `crosscheck` bin's `summarize-turn` subcommand; when the bin moved to
 * `packages/cli`, pointing the hook across packages would have given the
 * Claude connector a path dependency on the CLI package (the exact wrong
 * direction the extraction exists to end), so the worker entry lives HERE,
 * beside the worker it runs. The bin's `summarize-turn` subcommand remains
 * for operators (byte-identical dispatch); this file is what the hook uses.
 *
 * Same contract as the bin branch: no stdin read — input is named by flags —
 * and the exit code is the worker's own (nothing downstream reads it).
 */
import { runSummarizeWorker } from "./worker.ts";

process.exit(await runSummarizeWorker(process.argv.slice(2), process.env));
