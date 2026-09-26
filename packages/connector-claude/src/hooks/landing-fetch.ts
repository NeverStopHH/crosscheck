/**
 * The background fetch of the landing branches, asked for by three of this
 * connector's hooks (docs/1.0/landed-changes.md, step 2): SessionStart, every
 * prompt, and every edit — the edit because an agent can work for an hour on
 * one prompt, and the pre-edit stop can only see what the clone has fetched.
 *
 * Core decides whether a fetch is due and books it
 * (landed-changes/fetch-trigger.ts); this file only says how the worker
 * starts: its own entry, beside the hooks, in a session of its own.
 *
 * Never throws and never waits for the network: every hook runs it BESIDE its
 * own job, and the worst it can cost that job is the few milliseconds of the
 * "is one due?" check.
 */
import { resolve } from "node:path";

import {
  requestLandingFetch,
  startDetachedWorker,
} from "@crosscheck/connector-core/landed-changes/fetch-trigger.ts";
import type { HookContext } from "./runner.ts";

/** The worker's own entry, INSIDE this package (landing-fetch/worker-entry.ts). */
const LANDING_FETCH_WORKER_ENTRY_PATH = resolve(
  import.meta.dir,
  "..",
  "landing-fetch",
  "worker-entry.ts",
);

export const requestLandingFetchFor = async (ctx: HookContext): Promise<void> => {
  try {
    await requestLandingFetch({
      home: ctx.config.home,
      root: ctx.identity.root,
      env: ctx.env,
      now: ctx.now(),
      startWorker: (root) => {
        startDetachedWorker({
          cmd: [process.execPath, LANDING_FETCH_WORKER_ENTRY_PATH, "--root", root],
          env: ctx.env,
          home: ctx.config.home,
        });
      },
    });
  } catch {
    // Fail open: the hook's own job is untouched.
  }
};
