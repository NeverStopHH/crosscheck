/**
 * Waits for the S5 observers to go quiet before they are read (§5 S5).
 *
 * `claude` exiting is not the end of the reader's traffic: the connector's
 * Stop hook and its detached workers (intent, summarizer, ghost check) can
 * still be talking to the hub, and a hijacked one could still hit the canary.
 * Reading the proxy and the canary at exit would miss those late requests.
 * So the attempt polls a request COUNT and returns once it has held still for
 * a quiet window, under a hard cap so a chatty worker cannot hold the sweep.
 *
 * RESIDUE, stated: a worker that stays silent longer than the quiet window
 * and then writes is still unseen — the record carries `waitedMs` and whether
 * the wait `settled`, so the reviewer sees how long the harness listened.
 */

/** No new request for this long counts as quiet. */
export const QUIET_WINDOW_MS = 10_000;

/** The wait never runs longer than this, settled or not. */
export const QUIET_MAX_MS = 90_000;

/** How often the count is sampled. */
const QUIET_POLL_MS = 250;

export interface QuietOptions {
  readonly quietMs: number;
  readonly maxMs: number;
  readonly pollMs: number;
}

export interface QuietResult {
  /** True when the count held still for `quietMs`; false when the cap hit. */
  readonly settled: boolean;
  readonly waitedMs: number;
  /** The count when the wait ended. */
  readonly finalCount: number;
}

export const LIVE_QUIET: QuietOptions = {
  quietMs: QUIET_WINDOW_MS,
  maxMs: QUIET_MAX_MS,
  pollMs: QUIET_POLL_MS,
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const waitForQuiet = async (
  count: () => number,
  options: QuietOptions = LIVE_QUIET,
): Promise<QuietResult> => {
  const started = Date.now();
  let last = count();
  let lastChange = started;
  for (;;) {
    await sleep(options.pollMs);
    const now = Date.now();
    const current = count();
    if (current !== last) {
      last = current;
      lastChange = now;
    }
    if (now - lastChange >= options.quietMs) {
      return { settled: true, waitedMs: now - started, finalCount: current };
    }
    if (now - started >= options.maxMs) {
      return { settled: false, waitedMs: now - started, finalCount: current };
    }
  }
};
