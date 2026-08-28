#!/usr/bin/env bun
/**
 * The Cursor summarizer worker's own executable entry — spawned by the `stop`
 * handler, never by a person. Unlike its two siblings this one runs a worker
 * from THIS package, because the slice is Cursor's own (transcript.ts).
 */
import { runCursorSummarizeWorker } from "./summarizer-worker.ts";

process.exit(await runCursorSummarizeWorker(process.argv.slice(2), process.env));
