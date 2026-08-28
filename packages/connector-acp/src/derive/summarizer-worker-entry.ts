#!/usr/bin/env bun
/**
 * The ACP summarizer worker's own executable entry — spawned by the capture
 * engine at a turn boundary, never by a person. Unlike its two siblings this
 * one runs a worker from THIS package, because acquiring the slice is the
 * host's job and this host's slice arrives on stdin.
 */
import { runAcpSummarizeWorker } from "./summarizer-worker.ts";

process.exit(await runAcpSummarizeWorker(process.argv.slice(2), process.env));
