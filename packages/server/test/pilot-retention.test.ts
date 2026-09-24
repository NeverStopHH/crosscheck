/**
 * THE PILOT'S MEASUREMENT ROWS AGE OUT (1.0 spec 07 §4).
 *
 * `pilot_counters` and `pilot_attributions` prune past PILOT_RETENTION_DAYS,
 * on the hub's one standalone pass — the reaper — because neither is ever
 * revisited by the write that created it in a way that could retire it: a
 * counter row is keyed by its DAY, and nothing writes yesterday again.
 *
 * WHY THIS IS NOT THE SWEEP NICK WITHDREW. `session_events` is very nearly
 * the causal skeleton, and "forget content before you forget causality" is
 * why its age sweep stays off. These two tables hold no causality at all: a
 * counter is a per-day tally, and an attribution is a ranked GUESS the answer
 * made, not an order anybody proved. They are the measurement, and the
 * measurement's own window is bounded by the same number, so nothing a report
 * can read is removed.
 *
 * WHAT THESE PIN: the row one day past the window goes, the row ON the
 * boundary stays (a report at the widest window still reads it), and the
 * prune runs on a pass that has no session to reap — a retirement that only
 * happens when there is also something else to do is the defect 01's first
 * sweep had.
 */
import { describe, expect, test } from "bun:test";
import { PIN_PRESENCE_TERMINAL } from "@crosscheck/schema";

import { PILOT_RETENTION_DAYS } from "../src/constants.ts";
import { pilotAttributions, pilotCounters } from "../src/db/schema.ts";
import { reapStaleSessions } from "../src/services/sessions.ts";
import {
  TEST_START_ISO,
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
} from "./helpers.ts";
import type { TestHarness } from "./helpers.ts";

const REPO = "github.com/acme/api";
const PIN = "pin_retention";
const MS_PER_DAY = 86_400_000;

const now = new Date(TEST_START_ISO);
const daysAgo = (days: number): Date => new Date(now.getTime() - days * MS_PER_DAY);
const utcDay = (date: Date): string => date.toISOString().slice(0, 10);

const setup = async (): Promise<TestHarness> => {
  const harness = await createTestHarness();
  const developer = await createTestDeveloper(harness, "Nick", "nick-ret@example.com");
  const pinned = await harness.app.request(
    "/api/pins",
    jsonRequest("POST", developer.apiKey, {
      id: PIN,
      repo: REPO,
      surface: "Play button plays/pauses",
      files: ["src/workbench/usePlayback.ts"],
      check: "open /workbench, press Play",
      presence: PIN_PRESENCE_TERMINAL,
      verifiedAtCommit: "abc1234",
    }),
  );
  expect(pinned.status).toBe(200);
  return harness;
};

const counterOn = (day: string) => ({
  repo: REPO,
  day,
  surface: "api-suspect",
  counter: "answers_emitted",
  value: 1,
  updatedAt: now,
});

const attributionAt = (id: string, answeredAt: Date) => ({
  id,
  repo: REPO,
  pinId: PIN,
  outcome: "ranked" as const,
  falsifier: "recorded_break" as const,
  topSessionId: null,
  topLift: null,
  candidates: 0,
  coverageJudgeable: true,
  answeredAt,
});

const reap = (harness: TestHarness) =>
  reapStaleSessions({ db: harness.db, now: () => now });

describe("pilot retention", () => {
  test("a counter past the window goes; the one on the boundary stays", async () => {
    // Arrange
    const harness = await setup();
    const past = utcDay(daysAgo(PILOT_RETENTION_DAYS + 1));
    const boundary = utcDay(daysAgo(PILOT_RETENTION_DAYS));
    const today = utcDay(now);
    await harness.db
      .insert(pilotCounters)
      .values([counterOn(past), counterOn(boundary), counterOn(today)]);

    // Act — a pass with no session to reap
    await reap(harness);

    // Assert
    const days = (await harness.db.select({ day: pilotCounters.day }).from(pilotCounters))
      .map((row) => row.day)
      .sort();
    expect(days).toEqual([boundary, today]);
  });

  test("an attribution past the window goes; a recent one stays", async () => {
    // Arrange
    const harness = await setup();
    await harness.db
      .insert(pilotAttributions)
      .values([
        attributionAt("pa_old", daysAgo(PILOT_RETENTION_DAYS + 1)),
        attributionAt("pa_new", daysAgo(1)),
      ]);

    // Act
    await reap(harness);

    // Assert
    const ids = (await harness.db.select({ id: pilotAttributions.id }).from(pilotAttributions))
      .map((row) => row.id);
    expect(ids).toEqual(["pa_new"]);
  });

  test("the refusal count outlives the window while the set it describes stands", async () => {
    // Arrange — the fifty sessions are never pruned; aging their refusal
    // count out made a full set read as the whole population again
    const harness = await setup();
    await harness.db.insert(pilotCounters).values({
      repo: REPO,
      day: utcDay(daysAgo(PILOT_RETENTION_DAYS + 30)),
      surface: "pilot-sessions",
      counter: "pilot_sessions_refused",
      value: 3,
      updatedAt: now,
    });

    // Act
    await reap(harness);

    // Assert
    const refused = await harness.db.select().from(pilotCounters);
    expect(refused.map((row) => row.counter)).toEqual(["pilot_sessions_refused"]);
  });
});

