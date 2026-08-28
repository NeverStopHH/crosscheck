#!/usr/bin/env bun
/**
 * The detached derived-intent worker's OWN executable entry — spawned by the
 * UserPromptSubmit hook (hooks/user-prompt-submit.ts), never by a person;
 * the summarizer's worker-entry.ts, one directory over, states why the entry
 * lives beside its worker rather than in the CLI package. No stdin read —
 * input is named by flags (the prompt FILE, never the prompt) — and the exit
 * code is the worker's own (nothing downstream reads it).
 */
import { runIntentWorker } from "@crosscheck/connector-core/derive/intent/worker.ts";

process.exit(await runIntentWorker(process.argv.slice(2), process.env));
