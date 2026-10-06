/**
 * The adversarial probes of the opt-out rounds, kept as regression tests:
 * one describe per surface a review found still telling a colleague where
 * an opted-out developer is, or when she was there (services/live-location.ts
 * is the one projection; test/opted-out-world.ts the one seed).
 *
 * Each case reads the surface as Nick, who must see Robin's row in withheld
 * form and none of her SECRETS, and as Robin, who must still see her own.
 */
import { describe, expect, test } from "bun:test";
import { LOCATION_WITHHELD } from "@crosscheck/schema";

import {
  REPO,
  ROBIN_CONTEXT,
  UPDATED_AT,
  getAs,
  secretsIn,
  seedOptedOutWorld,
  url,
} from "./opted-out-world.ts";

interface ConferenceContext {
  readonly id: string;
  readonly lastActiveAt: string;
}

const conferenceContexts = (body: string): readonly ConferenceContext[] =>
  (JSON.parse(body) as { data: { conference: { contexts: readonly ConferenceContext[] } } }).data
    .conference.contexts;

describe("the conference", () => {
  test("says Robin's context is there and withholds when she was last active on it", async () => {
    const world = await seedOptedOutWorld();

    const asNick = await getAs(world, "nick", url("/api/conference", { repo: REPO }));
    const asRobin = await getAs(world, "robin", url("/api/conference", { repo: REPO }));

    expect(asNick.status).toBe(200);
    expect(secretsIn(asNick.body)).toEqual([]);
    expect(conferenceContexts(asNick.body).find((context) => context.id === ROBIN_CONTEXT)?.lastActiveAt)
      .toBe(LOCATION_WITHHELD);
    expect(conferenceContexts(asRobin.body).find((context) => context.id === ROBIN_CONTEXT)?.lastActiveAt)
      .toBe(UPDATED_AT);
  });
});
