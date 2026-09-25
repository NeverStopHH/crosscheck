/**
 * The hook side of the background landing fetch (docs/1.0/landed-changes.md,
 * step 2): is one due, and if so book it and start the worker — never wait.
 *
 * Session start, every prompt and every edit ask; almost always the answer is
 * "not due", which costs one bounded git call (the clone's key) and one small
 * file read. Only a due attempt pays for more.
 *
 * ONLY A CLONE THAT ALREADY TRACKS ORIGIN IS FETCHED — one with at least one
 * `refs/remotes/origin/*`. A remote someone added but never fetched from may
 * carry a wrong URL, or not be the team's at all, and the first contact with
 * it should be the developer's own `git fetch`, not a hook's.
 *
 * The connector supplies how the worker starts (its own entry file); this
 * module decides whether it does. `startDetachedWorker` below is the start
 * every connector uses.
 */
import type { Env } from "../config/paths.ts";
import { LANDED_GIT_TIMEOUT_MS } from "../constants.ts";
import { runGitOutcome } from "../git/git.ts";
import { summarizerWorkerEnv } from "../model/worker-env.ts";
import { readLandingFetchPlan } from "./fetch-switch.ts";
import {
  claimLandingFetch,
  cloneKeyOf,
  isLandingFetchDue,
  readLandingFetchRecord,
} from "./fetch-state.ts";
import { QUIET_GIT_ENV } from "./git-queries.ts";

export type LandingFetchRequest = "started" | "not-due" | "off" | "no-clone" | "not-tracking";

export interface LandingFetchRequestInput {
  readonly home: string;
  /** The worktree the hook fired in. */
  readonly root: string;
  readonly env: Env;
  readonly now: Date;
  /** Starts the detached worker for `root`; must return at once. */
  readonly startWorker: (root: string) => void;
}

/** At least one `refs/remotes/origin/*`: the clone has fetched from origin before. */
export const tracksOrigin = async (root: string): Promise<boolean> => {
  const outcome = await runGitOutcome(
    ["for-each-ref", "--count=1", "--format=%(refname)", "refs/remotes/origin/"],
    root,
    LANDED_GIT_TIMEOUT_MS,
    QUIET_GIT_ENV,
  );
  return outcome.ok && outcome.stdout.length > 0;
};

export const requestLandingFetch = async (input: LandingFetchRequestInput): Promise<LandingFetchRequest> => {
  const plan = await readLandingFetchPlan(input.root, input.env);
  if (plan.switch.kind === "off") {
    return "off";
  }
  const key = await cloneKeyOf(input.root);
  if (key === null) {
    return "no-clone";
  }
  // Lockless first: the answer is "not due" on almost every hook.
  if (!isLandingFetchDue(await readLandingFetchRecord(input.home, key), input.now)) {
    return "not-due";
  }
  if (!(await tracksOrigin(input.root))) {
    return "not-tracking";
  }
  if (!(await claimLandingFetch(input.home, key, input.now))) {
    return "not-due";
  }
  input.startWorker(input.root);
  return "started";
};

export interface DetachedWorkerInput {
  /** argv, entry path included. */
  readonly cmd: readonly string[];
  readonly env: Env;
  readonly home: string;
}

/**
 * IN ITS OWN SESSION, WITH NO CONTROLLING TERMINAL (`detached`: setsid). This
 * is not tidiness. A child a hook starts the ordinary way can open /dev/tty —
 * measured — and ssh opens exactly that to ask for a key passphrase, which
 * would print on the agent's screen and read the developer's next keystrokes
 * as the answer. Without a terminal there is nothing to ask on, whatever ssh
 * command the developer configured.
 *
 * Otherwise the derive workers' shape: stdio ignored, unref'd, the worker env
 * minus the parent session's markers, and a failed start swallowed — the
 * attempt is booked, and losing one fetch is the cheap outcome.
 */
export const startDetachedWorker = (input: DetachedWorkerInput): void => {
  try {
    const proc = Bun.spawn({
      cmd: [...input.cmd],
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: summarizerWorkerEnv(input.env, input.home),
      detached: true,
    });
    proc.unref();
  } catch {
    // Fail open.
  }
};
