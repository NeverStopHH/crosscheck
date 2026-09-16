/**
 * COV-11's OTHER HALF — what the caveat costs on the surface that carries it
 * every single time, measured end to end rather than argued about.
 *
 * §5.1 does not settle its own noise argument. It defers it by name: *"COV-11
 * measures the resulting distribution before merge... If `complete` is still
 * unreachable when scoped, §5.1 and §10.4 are re-decided on that measurement
 * rather than on this paragraph."* The measurement that shipped
 * (server/test/coverage-measurement.test.ts) answers REACHABILITY — can
 * `agent_event` reach `complete` at all, unscoped and scoped — and stops
 * there. Reachability is not the fire rate, and the fire rate is the quantity
 * decision 4 was about.
 *
 * SO THIS MEASURES THE FIRE RATE, on the path that pays it. `GET
 * /api/absences` reads coverage UNSCOPED — §3.2a says so on purpose: *"the
 * briefing and doctor pass nothing and get the repo-wide answer"* — and by
 * decision 2 the line it produces is FIRST and UNCUTTABLE on every
 * SessionStart. Unscoped `agent_event` is `incomplete` if ANY session in
 * COVERAGE_SESSION_WINDOW_DAYS was reaped, and the hub's own source says the
 * reap over-fires: *"an afternoon of reading and planning looks like a killed
 * terminal"* (server/src/services/records.ts:71-79). One such afternoon
 * therefore buys a caveat on every briefing until it ages out of the window.
 *
 * Nothing here changes that behaviour — it is the spec's, and decision 2 is
 * Nick's. What was missing is the NUMBER, and a number nobody produced is a
 * decision nobody made. This is the real hub, the real wire, the real
 * renderer and a real clock walking a fortnight.
 *
 * THE INVARIANTS IT PINS (no thresholds — that is COV-11's rule and it holds
 * here): the caveat appears the moment a reap does; its lifetime is BOUNDED
 * by COVERAGE_SESSION_WINDOW_DAYS and it goes silent by itself; and the
 * sentence is not the same sentence every day — the age advances, so a reader
 * can tell one ageing fact from a gap that keeps recurring.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createDb, createServer } from "@crosscheck/server";
import type { Db } from "@crosscheck/server";
import { coverageNote } from "../src/coverage/render.ts";
import { getAbsences } from "../src/http/hub.ts";
import type { HubContext } from "../src/http/client.ts";

const REPO = "github.com/acme/api";
const ADMIN_TOKEN = "fire-rate-admin-token";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The hub's own window and its own reap threshold. Restated rather than
 * imported because the connector reads neither constant at runtime, and
 * pinned against their source so the two cannot drift:
 *
 * VERIFY: bun -e 'const c=await import("./packages/server/src/constants.ts");console.log(c.COVERAGE_SESSION_WINDOW_DAYS, c.SESSION_REAP_STALE_HOURS)'
 * PRINTS: 14 6
 */
const WINDOW_DAYS = 14;
const REAP_STALE_HOURS = 6;

const START = new Date("2026-07-24T09:00:00.000Z");

let clock = new Date(START);
let db: Db;
let server: ReturnType<typeof Bun.serve>;
let hubUrl = "";
let apiKey = "";

const post = async (path: string, body: unknown): Promise<Response> =>
  fetch(`${hubUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

const session = (id: string): Record<string, unknown> => ({
  id,
  agentKind: "claude-code",
  repo: REPO,
  branch: "main",
  baseCommit: "a1b2c3d4",
  status: "analyzing",
});

const ctx = (): HubContext => ({
  hubUrl,
  apiKey,
  timeoutMs: 5000,
  home: "/tmp/does-not-exist",
  repoKey: "",
  now: () => new Date(clock),
});

beforeAll(async () => {
  db = await createDb();
  const app = createServer({
    db,
    adminToken: ADMIN_TOKEN,
    now: () => new Date(clock),
  });
  server = Bun.serve({ port: 0, fetch: app.fetch });
  hubUrl = `http://127.0.0.1:${String(server.port)}`;

  const created = await fetch(`${hubUrl}/api/developers`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: "Ada", email: "ada@acme.example" }),
  });
  const body = (await created.json()) as { data: { apiKey: string } };
  apiKey = body.data.apiKey;

  // Day 0, 09:00 — an afternoon of reading and planning. The session opens
  // and never says goodbye, because the terminal it was in went away.
  expect((await post("/api/sessions", session("cc_reading-uuid"))).status).toBe(
    200,
  );

  // Seven hours later the developer opens a new one. Registering it reaps
  // their own stale session on the way in (routes/sessions.ts) — the hub
  // closing a session on a GUESS, which is the whole event being measured.
  clock = new Date(START.getTime() + (REAP_STALE_HOURS + 1) * HOUR_MS);
  expect((await post("/api/sessions", session("cc_working-uuid"))).status).toBe(
    200,
  );
  // And this one ends properly, so the only gap in the fortnight below is the
  // reap. Everything else about this repo is exemplary.
  expect(
    (await post("/api/sessions/cc_working-uuid/end", { status: "done" })).status,
  ).toBe(200);
});

afterAll(() => {
  server.stop(true);
});

describe("what one over-fired reap costs the briefing", () => {
  test("the caveat rides every SessionStart in the window, then stops by itself", async () => {
    // Arrange: a fortnight of SessionStarts, one per day, against the hub the
    // briefing actually calls.
    const start = new Date(START.getTime() + (REAP_STALE_HOURS + 1) * HOUR_MS);
    const days = WINDOW_DAYS + 1;
    const notes: (string | null)[] = [];

    // Act
    for (let day = 0; day < days; day += 1) {
      clock = new Date(start.getTime() + day * DAY_MS);
      const result = await getAbsences(ctx(), REPO);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      notes.push(coverageNote(result.data.coverage, new Date(clock)));
    }
    const fired = notes.filter((note): note is string => note !== null);
    const firstSilent = notes.findIndex((note) => note === null);
    process.stdout.write(
      `COV-11 fire rate — one reaped session, nothing else wrong: the ` +
        `briefing carried the coverage line on ${String(fired.length)} of ` +
        `${String(days)} SessionStarts; first silent on day ` +
        `${String(firstSilent)} of ${String(WINDOW_DAYS)}\n` +
        `  day 0:  ${String(notes[0])}\n` +
        `  day ${String(WINDOW_DAYS - 1)}: ${String(notes[WINDOW_DAYS - 1])}\n` +
        `  day ${String(WINDOW_DAYS)}: ${String(notes[WINDOW_DAYS])}\n`,
    );

    // Assert — three invariants, no threshold.
    //
    // 1. A reap is a gap and is reported the day it happens. If this ever
    //    goes quiet the caveat has stopped doing its job, which is the
    //    expensive direction.
    expect(notes[0]).not.toBeNull();
    // 2. ITS LIFETIME IS BOUNDED, and bounded by a constant a reader can look
    //    up rather than by whether anybody fixed anything: the reap is
    //    revocable only by a record from the session it closed, which will
    //    never arrive, so the window is the only thing that ends it.
    expect(notes[WINDOW_DAYS]).toBeNull();
    expect(fired.length).toBe(WINDOW_DAYS);
    // 3. And it is not the same sentence every day. The instant is fixed —
    //    COV-1 requires it — so without the age beside it a reader cannot
    //    tell an ageing fact from a gap that keeps recurring.
    expect(new Set(fired).size).toBe(fired.length);
  });
});
