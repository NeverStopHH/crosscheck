/**
 * A deferred end the hub has never heard of is TERMINAL (trial finding M6).
 *
 * `DeferredEnder` used to answer a boolean, so "the hub said no" and "the hub
 * said this session does not exist" were the same answer: keep the marker and
 * try again next SessionStart. A session whose first registration failed has a
 * marker the hub will 404 forever — the trial machine was carrying one 48
 * hours old — and each SessionStart spent a hub call and a spool lookup on it
 * until MAX_SPOOL_AGE_DAYS retired it seven days later.
 *
 * Three outcomes now: `"ended"` and `"gone"` both spend the marker, `"retry"`
 * keeps it. The distinction the test pins is that `"gone"` costs exactly one
 * reap.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureDir, spoolDir, spoolPendingEndPath } from "../src/config/paths.ts";
import { reapSpool } from "../src/spool/reap.ts";
import type { DeferredEnder } from "../src/spool/reap.ts";

const KEY = "deadbeefcafebabe";
const SLUG = "gone-uuid";
const SESSION_ID = `cc_${SLUG}`;

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(
    paths.map((path) => rm(path, { recursive: true, force: true })),
  );
  paths.length = 0;
});

const homeWithMarker = async (): Promise<string> => {
  const home = await mkdtemp(join(tmpdir(), "cx-pending-end-"));
  paths.push(home);
  await ensureDir(spoolDir(home, KEY));
  await writeFile(
    spoolPendingEndPath(home, KEY, SLUG),
    `${JSON.stringify({
      crosscheckSessionId: SESSION_ID,
      at: new Date().toISOString(),
    })}\n`,
    "utf8",
  );
  return home;
};

const markerExists = (home: string): Promise<boolean> =>
  Bun.file(spoolPendingEndPath(home, KEY, SLUG)).exists();

/** What session-start's ender returns when the hub answers 404. */
const goneEnder =
  (asked: string[]): DeferredEnder =>
  async (sessionId) => {
    asked.push(sessionId);
    return "gone";
  };

/** What it returns when the hub simply did not answer. */
const retryEnder =
  (asked: string[]): DeferredEnder =>
  async (sessionId) => {
    asked.push(sessionId);
    return "retry";
  };

describe("a deferred end the hub 404s", () => {
  test("is spent in ONE reap rather than retried until it ages out", async () => {
    // Arrange
    const home = await homeWithMarker();
    const asked: string[] = [];

    // Act
    await reapSpool(home, KEY, new Date(), goneEnder(asked));

    // Assert
    expect(asked).toEqual([SESSION_ID]);
    expect(await markerExists(home)).toBe(false);
  });

  test("a hub that merely did not answer keeps its marker for next time", async () => {
    // Arrange
    const home = await homeWithMarker();
    const asked: string[] = [];

    // Act
    await reapSpool(home, KEY, new Date(), retryEnder(asked));

    // Assert: an unanswered end must never be able to disappear
    expect(asked).toEqual([SESSION_ID]);
    expect(await markerExists(home)).toBe(true);
  });

  test("a second reap after 'gone' has nothing left to ask about", async () => {
    // Arrange
    const home = await homeWithMarker();
    const asked: string[] = [];

    // Act
    await reapSpool(home, KEY, new Date(), goneEnder(asked));
    await reapSpool(home, KEY, new Date(), goneEnder(asked));

    // Assert: exactly one hub call was ever spent on it
    expect(asked).toEqual([SESSION_ID]);
  });
});
