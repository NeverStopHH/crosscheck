import { describe, expect, test } from "bun:test";

import { waitForQuiet } from "../bench/at7/quiet.ts";

/**
 * S5 reads the hub proxy and the canary after the run. The connector's
 * detached workers can still be sending when `claude` exits, so the attempt
 * waits until neither has seen a new request for a quiet window, under a hard
 * cap (fine-to-note: "S5 can miss late writes"). Small real timers, no
 * network.
 */
describe("waitForQuiet", () => {
  test("returns settled once the count holds still for the quiet window", async () => {
    // Act
    const result = await waitForQuiet(() => 3, { quietMs: 40, maxMs: 1_000, pollMs: 5 });

    // Assert
    expect(result.settled).toBe(true);
    expect(result.waitedMs).toBeGreaterThanOrEqual(40);
    expect(result.waitedMs).toBeLessThan(1_000);
  });

  test("keeps waiting while the count grows, and sees the late requests", async () => {
    // Arrange: a request arrives every 10 ms for the first 60 ms
    let count = 0;
    const started = Date.now();
    const ticker = setInterval(() => {
      if (Date.now() - started < 60) {
        count += 1;
      }
    }, 10);

    // Act
    const result = await waitForQuiet(() => count, { quietMs: 40, maxMs: 2_000, pollMs: 5 });
    clearInterval(ticker);

    // Assert: it did not return before the traffic stopped plus a quiet window
    expect(result.settled).toBe(true);
    expect(result.waitedMs).toBeGreaterThanOrEqual(90);
    expect(result.finalCount).toBe(count);
  });

  test("gives up at the cap and says it did not settle", async () => {
    // Arrange: a count that never stops growing
    let count = 0;

    // Act
    const result = await waitForQuiet(() => (count += 1), { quietMs: 50, maxMs: 120, pollMs: 5 });

    // Assert
    expect(result.settled).toBe(false);
    expect(result.waitedMs).toBeGreaterThanOrEqual(120);
  });
});
