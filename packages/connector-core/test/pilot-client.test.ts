/**
 * THE PILOT REPORT ON THE WIRE (1.0 spec 07 §5), read by the client.
 *
 * THIS PARSE IS STRICT, and that is the inversion worth pinning. Every other
 * hub answer in this package defaults a missing count to zero, because a
 * missing count there costs a line. Here a zero IS the claim: "missed 0",
 * "surfaced 0", "hit 0". A count that did not arrive and reads as zero is
 * AT-9's exact failure — an unmeasured figure looking like a perfect one — on
 * the report whose whole job is to say whether the product works. So a
 * report with a figure missing is a report this client cannot read, and it
 * says so rather than printing the zero.
 *
 * WHAT STAYS OPEN is what a newer hub may legitimately add: a reason this
 * client has no sentence for, a channel it has not heard of, a field it does
 * not know. Each arrives and is printed as itself.
 *
 * THE CONTRACT HALF runs a real hub, because the two sides of this wire are
 * written in different packages and nothing else notices the day one of them
 * renames a field.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { createDb, createServer } from "@crosscheck/server";
import { DELIVERY_CHANNELS } from "@crosscheck/schema";

import { getPilotReport, PilotReportSchema } from "../src/http/pilot.ts";
import type { HubContext } from "../src/http/client.ts";
import { makeHome } from "./helpers.ts";

const ADMIN_TOKEN = "pilot-client-admin";
const REPO = "github.com/acme/api";

let server: ReturnType<typeof Bun.serve>;
let hubUrl: string;
let home: string;
let apiKey: string;

const ctx = (): HubContext => ({
  hubUrl,
  apiKey,
  timeoutMs: 4000,
  home,
  repoKey: "pilot-client",
  now: () => new Date(),
});

const measured = (value: number) => ({ kind: "measured", value });

/** A report as the hub sends one — every field present. */
const wireReport = (): Record<string, unknown> => ({
  repo: REPO,
  enrolled: true,
  sinceIso: "2026-07-20T00:00:00.000Z",
  untilIso: "2026-09-14T00:00:00.000Z",
  days: 56,
  sessionSet: {
    used: 31,
    cap: 50,
    refused: 0,
    spanned: 29,
    restarted: 1,
    notRecorded: 1,
  },
  duplicateWork: {
    surfaced: 312,
    opened: 74,
    converged: 31,
    byChannel: {
      unknown: 0,
      briefing: 208,
      prompt_hint: 96,
      tripwire: 8,
      suspect: 0,
    },
    priorWork: [
      { workContextId: "wc_8f21", title: "Widen the filter row", openedBySessions: 2 },
    ],
    priorWorkBeyondList: 0,
    openedAnyway: 19,
  },
  collisions: {
    tripwireFlagged: measured(8),
    ghostFlagged: { kind: "unavailable", reason: "ghost_lines_not_recorded" },
    bothLanded: measured(3),
    ciRegressed: { kind: "unavailable", reason: "no_ci_reporter" },
  },
  attribution: {
    answers: 6,
    attributions: 5,
    excluded: 1,
    repaired: [
      {
        pinId: "pin_a",
        repairPinId: "pin_b",
        brokenCommit: "abc1234",
        repairCommit: "def5678",
        namedFiles: ["src/workbench/usePlayback.ts"],
      },
    ],
    repairedBeyondBound: 0,
    noRepairYet: 2,
  },
  precision: {
    sessions: 1208,
    openedPer100: measured(6.1),
    openedTargetPer100: 8,
    offTargetMarks: 11,
    offTargetPer100: measured(0.9),
    offTargetCeilingPer100: 20,
    surfaceOkMarks: 4,
  },
  integrity: [
    { surface: "api-suspect", counters: { answers_emitted: 12 } },
    { surface: "api-search", counters: null },
  ],
});

beforeAll(async () => {
  const db = await createDb();
  server = Bun.serve({
    port: 0,
    fetch: createServer({ db, adminToken: ADMIN_TOKEN }).fetch,
  });
  hubUrl = `http://127.0.0.1:${String(server.port)}`;
  home = await makeHome("pilot-client");
  const created = await fetch(`${hubUrl}/api/developers`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: "Nick", email: "nick-pilot-client@example.com" }),
  });
  apiKey = ((await created.json()) as { data: { apiKey: string } }).data.apiKey;
});

afterAll(async () => {
  server.stop(true);
  await rm(home, { recursive: true, force: true });
});

describe("PilotReportSchema", () => {
  test("reads a complete report", () => {
    // Arrange & Act
    const parsed = PilotReportSchema.safeParse(wireReport());

    // Assert
    expect(parsed.success).toBe(true);
  });

  test("a count that did not arrive is NOT read as zero", () => {
    // Arrange — the defaulting convention everywhere else in this package
    // would turn this into "surfaced 0" beside a real "opened 74".
    const report = wireReport();
    const { surfaced: _dropped, ...rest } = report.duplicateWork as Record<
      string,
      unknown
    >;

    // Act
    const parsed = PilotReportSchema.safeParse({ ...report, duplicateWork: rest });

    // Assert
    expect(parsed.success).toBe(false);
  });

  test("a measured figure with no value is not a measurement", () => {
    // Arrange
    const report = wireReport();
    const collisions = {
      ...(report.collisions as Record<string, unknown>),
      bothLanded: { kind: "measured" },
    };

    // Act
    const parsed = PilotReportSchema.safeParse({ ...report, collisions });

    // Assert
    expect(parsed.success).toBe(false);
  });

  test("a reason this client has no sentence for still arrives", () => {
    // Arrange — a newer hub may know an absence this client does not; the
    // renderer prints the word, which is better than refusing the report.
    const report = wireReport();
    const collisions = {
      ...(report.collisions as Record<string, unknown>),
      ciRegressed: { kind: "unavailable", reason: "reporter_paused" },
    };

    // Act
    const parsed = PilotReportSchema.safeParse({ ...report, collisions });

    // Assert
    expect(parsed.success).toBe(true);
    expect(parsed.data?.collisions.ciRegressed).toEqual({
      kind: "unavailable",
      reason: "reporter_paused",
    });
  });

  test("an uninstrumented surface keeps its null — it never becomes an empty record", () => {
    // Arrange & Act — PIL-4 at the client: `{}` would print as a surface that
    // answered nothing, `null` prints as one nobody counted.
    const parsed = PilotReportSchema.safeParse(wireReport());

    // Assert
    expect(parsed.data?.integrity[1]?.counters).toBeNull();
  });
});

describe("getPilotReport against a real hub", () => {
  test("the hub's report parses — the two halves of the wire agree", async () => {
    // Arrange — enrolled, so the report is the whole shape.
    await fetch(`${hubUrl}/api/team-settings`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ repo: REPO, pilotEnrolled: true }),
    });

    // Act
    const result = await getPilotReport(ctx(), { repo: REPO, days: 14 });

    // Assert
    if (!result.ok) {
      throw new Error(`report did not parse: ${result.kind} ${result.message}`);
    }
    expect(result.data.enrolled).toBe(true);
    expect(result.data.days).toBe(14);
    expect(Object.keys(result.data.duplicateWork.byChannel).sort()).toEqual(
      [...DELIVERY_CHANNELS].sort(),
    );
  });

  test("a repo nobody enrolled answers, and says so", async () => {
    // Arrange & Act
    const result = await getPilotReport(ctx(), { repo: "github.com/acme/web" });

    // Assert
    expect(result.ok).toBe(true);
    expect(result.ok && result.data.enrolled).toBe(false);
  });
});
