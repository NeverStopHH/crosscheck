/**
 * WITHHOLDING HER LOCATION DOES NOT EAT HER WORDS (review round 5, H1).
 *
 * The round-4 shape test withheld any string that OPENED like an instant or
 * WAS a bare sha or number — so a description, an intent, a question or a
 * claim body that starts with a log line's timestamp, or a claim whose body
 * is the bisected commit, reached her colleagues as «withheld (presence
 * opt-out)». Prose is hers to publish (visibility.ts «words»): only a value
 * that is ENTIRELY an instant is withheld by shape, and a bare hex or digit
 * string only in a field whose type is an instant or a commit.
 */
import { describe, expect, test } from "bun:test";
import { WITHHELD_TITLE } from "@crosscheck/schema";

import { jsonRequest } from "./helpers.ts";
import { BISECT_SHA, HER_WORDS, TEAM_REPO, buildTeamWorld } from "./team-world.ts";
import type { TeamWorld } from "./team-world.ts";

interface Claim {
  readonly id: string;
  readonly body: string;
}

interface Diagnosis {
  readonly workContext: {
    readonly title: string;
    readonly description: string | null;
    readonly intent: { readonly summary?: string } | null;
    readonly baseCommit?: string;
  };
  readonly claims: readonly Claim[];
}

const dataOf = async <T>(world: TeamWorld, path: string): Promise<T> => {
  const response = await world.harness.app.request(path, jsonRequest("GET", world.nick.apiKey));
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: T }).data;
};

const bodyOf = (diagnosis: Diagnosis, id: string): string | undefined =>
  diagnosis.claims.find((claim) => claim.id === id)?.body;

describe("her prose reaches a colleague as she wrote it, opted out or not", () => {
  test.each([[false], [true]] as const)("Robin opted out: %p", async (robinOptsOut) => {
    const world = await buildTeamWorld(robinOptsOut);

    const diagnosis = await dataOf<Diagnosis>(world, "/api/work-contexts/wc_robin_a/diagnosis?telemetry=0");
    const inbox = await dataOf<{ inbox: readonly { id: string; body: string }[] }>(world, `/api/questions?repo=${encodeURIComponent(TEAM_REPO)}`);
    const pins = await dataOf<{ pins: readonly { id: string; surface: string; check: string | null }[] }>(world, `/api/pins?repo=${encodeURIComponent(TEAM_REPO)}`);

    expect(diagnosis.workContext.description).toBe(HER_WORDS.description);
    expect(diagnosis.workContext.intent?.summary).toBe(HER_WORDS.intentSummary);
    expect(bodyOf(diagnosis, "clm_r_obs")).toBe(HER_WORDS.logLineClaim);
    expect(bodyOf(diagnosis, "clm_r_sha")).toBe(BISECT_SHA);
    expect(inbox.inbox.find((question) => question.id === "q_robin")?.body).toBe(HER_WORDS.question);
    expect(pins.pins.find((pin) => pin.id === "pin_r")).toMatchObject({ surface: HER_WORDS.pinSurface, check: HER_WORDS.pinCheck });
  });

  test("her location is still withheld beside her words", async () => {
    const world = await buildTeamWorld(true);

    const diagnosis = await dataOf<Diagnosis>(world, "/api/work-contexts/wc_robin_a/diagnosis?telemetry=0");

    expect(diagnosis.workContext.title).toBe(WITHHELD_TITLE);
    expect(diagnosis.workContext.baseCommit).toBeUndefined();
  });
});
