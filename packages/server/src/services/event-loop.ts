/**
 * A turn of the event loop, for a long background pass to take between pages.
 *
 * PGlite runs each statement synchronously and an awaited query settles
 * through microtasks only, so a chain of them never lets a timer or an
 * incoming request run: a pass that never took a turn held every request
 * until it was done — the review measured one at 18 873 ms during a
 * 30 000-context keyless doc upgrade (round 4, H1).
 */
export const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });
