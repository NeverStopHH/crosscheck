#!/usr/bin/env bun
/**
 * The detached ghost-check worker's OWN executable entry — spawned by the
 * UserPromptSubmit hook when a session owes a ghost check, never by a person.
 * The intent worker's entry, one directory over, states why the entry lives
 * beside its worker rather than in the CLI package. No stdin read (the model
 * input is built inside the worker and handed to the CHILD's stdin) and no
 * file on argv, because this worker needs neither: everything it compares is
 * already in session state or on the hub.
 */
import { runGhostWorker } from "./worker.ts";

process.exit(await runGhostWorker(process.argv.slice(2), process.env));
