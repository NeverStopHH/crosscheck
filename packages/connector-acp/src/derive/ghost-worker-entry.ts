#!/usr/bin/env bun
/**
 * The ghost-check worker's ACP entry — spawned by the capture engine when a
 * session owes a ghost check, never by a person. intent-worker-entry.ts
 * beside it states why the entry lives here while the worker lives in core.
 */
import { runGhostWorker } from "@crosscheck/connector-core/derive/ghost/worker.ts";

process.exit(await runGhostWorker(process.argv.slice(2), process.env));
