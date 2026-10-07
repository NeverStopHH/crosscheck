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

// The connector's own rule for "solved" — a test-only import (the hub does
// not depend on the connector), the same one live-location-privacy uses.
import { solvedAtFromTree } from "../../connector-core/src/mcp/render.ts";
import { listSolvedInfo } from "../src/services/solved.ts";
import { jsonRequest, postRecords, recordEnvelope } from "./helpers.ts";
import { BISECT_SHA, CI_RUN, HER_WORDS, ROBIN_S, TEAM_REPO, buildTeamWorld } from "./team-world.ts";
import type { TeamWorld } from "./team-world.ts";

/** A target value that is, whole, a calendar date: the release cut she works against. */
const RELEASE_CUT = "2026-07-24";

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

  test.each([[false], [true]] as const)("Robin opted out: %p — her evidence refs survive and the connector agrees her trees are solved (H2)", async (robinOptsOut) => {
    const world = await buildTeamWorld(robinOptsOut);
    const ids = ["wc_robin_a", "wc_robin_b", "wc_robin_c"];
    const hub = await listSolvedInfo(world.harness.db, ids);

    const verdicts = await Promise.all(
      ids.map(async (id) => {
        const diagnosis = await dataOf<Parameters<typeof solvedAtFromTree>[0] & Diagnosis>(world, `/api/work-contexts/${id}/diagnosis?telemetry=0`);
        return { id, hub: hub.has(id), connector: solvedAtFromTree(diagnosis) !== null, diagnosis };
      }),
    );
    const refsOf = (id: string, claimId: string): readonly string[] | undefined =>
      (verdicts.find((verdict) => verdict.id === id)?.diagnosis.claims.find((claim) => claim.id === claimId) as { evidenceRefs?: readonly string[] } | undefined)?.evidenceRefs;

    expect(verdicts.map(({ id, hub: h, connector }) => `${id}: hub ${String(h)}, connector ${String(connector)}`)).toEqual(
      verdicts.map(({ id, hub: h }) => `${id}: hub ${String(h)}, connector ${String(h)}`),
    );
    expect(hub.has("wc_robin_a")).toBe(true);
    expect(refsOf("wc_robin_a", "clm_r_root")).toEqual([BISECT_SHA]);
    expect(refsOf("wc_robin_b", "clm_r_b_root")).toEqual(["clm_r_bisect", CI_RUN]);
  });

  test.each([[false], [true]] as const)("Robin opted out: %p — a target she worked on matches a colleague's prompt as it is, whatever it looks like (L3)", async (robinOptsOut) => {
    // Arrange: the release cut she is working against is named by its date.
    const world = await buildTeamWorld(robinOptsOut);
    const posted = await postRecords(world.harness, world.robin, {
      records: [recordEnvelope("target", { workContextId: "wc_robin_a", kind: "symbol", value: RELEASE_CUT }, { sessionId: ROBIN_S })],
    });
    expect(posted.data?.rejected).toBe(0);

    // Act
    const hints = await dataOf<{ candidates: readonly { workContext: { id: string }; matchedTargets: readonly { kind: string; value: string }[] }[] }>(
      world,
      `/api/hints/candidates?repo=${encodeURIComponent(TEAM_REPO)}&query=${encodeURIComponent(`${RELEASE_CUT} token refresh`)}`,
    );

    // Assert
    const hers = hints.candidates.find((candidate) => candidate.workContext.id === "wc_robin_a");
    expect(hers?.matchedTargets).toContainEqual(expect.objectContaining({ kind: "symbol", value: RELEASE_CUT }));
  });

  test("her location is still withheld beside her words", async () => {
    const world = await buildTeamWorld(true);

    const diagnosis = await dataOf<Diagnosis>(world, "/api/work-contexts/wc_robin_a/diagnosis?telemetry=0");

    expect(diagnosis.workContext.title).toBe(WITHHELD_TITLE);
    expect(diagnosis.workContext.baseCommit).toBeUndefined();
  });
});
