/**
 * The pilot's own health in `crosscheck doctor` (1.0 spec 07 §5, PIL-3,
 * PIL-8).
 *
 * WHAT THESE PIN:
 *   · enrolment is said either way — a repo that is measured and one that is
 *     not must never read alike;
 *   · the one WARN divides answers by answers (PIL-3). #50 learned this
 *     measured: a gate that weighed turns against files could not tell a
 *     starved lane from a healthy one with nothing to find;
 *   · a rung that cannot exist here is a PASS line with its reason (PIL-8),
 *     never an absence and never a zero — and a figure that is merely empty
 *     today (`nothing_flagged`) is not a rung and is not printed as one.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { runDoctor } from "../src/cli/doctor.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const paths: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
const HTTP_NOT_FOUND = 404;
const HTTP_SERVER_ERROR = 500;

afterEach(async () => {
  for (const server of servers) {
    server.stop(true);
  }
  servers.length = 0;
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

type Counters = Readonly<Record<string, number>> | null;

interface ReportShape {
  readonly enrolled?: boolean;
  readonly refused?: number;
  readonly integrity?: readonly { surface: string; counters: Counters }[];
  readonly ciReason?: string;
}

const pilotReport = (shape: ReportShape): Record<string, unknown> => ({
  repo: "github.com/acme/api",
  enrolled: shape.enrolled ?? true,
  sinceIso: "2026-09-23T00:00:00.000Z",
  untilIso: "2026-09-24T00:00:00.000Z",
  days: 1,
  sessionSet: {
    used: 31,
    cap: 50,
    refused: shape.refused ?? 0,
    spanned: 30,
    restarted: 1,
    notRecorded: 0,
  },
  duplicateWork: {
    surfaced: 0,
    opened: 0,
    converged: 0,
    byChannel: { unknown: 0, briefing: 0, prompt_hint: 0, tripwire: 0, suspect: 0 },
    priorWork: [],
    priorWorkBeyondList: 0,
    openedAnyway: 0,
  },
  collisions: {
    tripwireFlagged: { kind: "measured", value: 0 },
    ghostFlagged: { kind: "unavailable", reason: "ghost_lines_not_recorded" },
    bothLanded: { kind: "unavailable", reason: "nothing_flagged" },
    ciRegressed: { kind: "unavailable", reason: shape.ciReason ?? "no_ci_reporter" },
  },
  attribution: {
    answers: 0,
    attributions: 0,
    excluded: 0,
    repaired: [],
    repairedBeyondBound: 0,
    noRepairYet: 0,
  },
  precision: {
    sessions: 0,
    openedPer100: { kind: "unavailable", reason: "no_sessions" },
    openedTargetPer100: 8,
    offTargetMarks: 0,
    offTargetPer100: { kind: "unavailable", reason: "no_sessions" },
    offTargetCeilingPer100: 20,
    surfaceOkMarks: 0,
  },
  integrity: shape.integrity ?? [{ surface: "api-suspect", counters: null }],
});

const hubWith = (answer: () => Response): string => {
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/pilot/report") {
        return answer();
      }
      return Response.json({ ok: true, data: { sessions: [] } });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${String(server.port)}`;
};

const doctor = async (answer: () => Response): Promise<string> => {
  const repo = await makeRepo("doctor-pilot", { remote: "git@github.com:acme/api.git" });
  const home = await makeHome("doctor-pilot");
  paths.push(repo, home);
  const result = await runDoctor(
    {
      CROSSCHECK_HOME: home,
      HOME: home,
      CROSSCHECK_HUB_URL: hubWith(answer),
      CROSSCHECK_API_KEY: "test-key",
    },
    repo,
    async () => null,
  );
  return result.stdout;
};

const serving = (shape: ReportShape) => (): Response =>
  Response.json({ ok: true, data: pilotReport(shape) });

describe("the pilot doctor lines", () => {
  test("a repo nobody enrolled is said to be unmeasured", async () => {
    // Arrange & Act
    const stdout = await doctor(serving({ enrolled: false }));

    // Assert
    expect(stdout).toContain("PASS  pilot  not enrolled");
    expect(stdout).not.toContain("pilot qualifiers");
  });

  test("an enrolled repo says how much of the session set is used", async () => {
    // Arrange & Act
    const stdout = await doctor(serving({}));

    // Assert
    expect(stdout).toContain("PASS  pilot  enrolled · session set 31 of 50");
    expect(stdout).not.toContain("refused at the cap");
  });

  test("a full set says what happened to the sessions after it", async () => {
    // Arrange & Act
    const stdout = await doctor(serving({ refused: 4 }));

    // Assert — counted, never dropped
    expect(stdout).toContain("4 later session(s) refused at the cap and counted");
  });

  test("an answer that went out without its qualifier is a WARN, answers over answers", async () => {
    // Arrange — three answers needed the qualifier, two carried it.
    const stdout = await doctor(
      serving({
        integrity: [
          { surface: "api-suspect", counters: { qualifier_required: 2, qualifier_emitted: 2 } },
          { surface: "api-search", counters: { qualifier_required: 1, qualifier_emitted: 0 } },
        ],
      }),
    );

    // Assert
    expect(stdout).toContain(
      "WARN  pilot qualifiers  1 of 3 answer(s) that needed a coverage qualifier went out without one",
    );
  });

  test("every qualifier carried is a PASS, however many surfaces counted", async () => {
    // Arrange — three answers over TWO surfaces, so a gate that weighed the
    // answers against the surfaces that produced them (PIL-3's mixed-unit
    // shape) would find one "missing" and invent a WARN.
    const stdout = await doctor(
      serving({
        integrity: [
          { surface: "api-suspect", counters: { qualifier_required: 2, qualifier_emitted: 2 } },
          { surface: "api-search", counters: { qualifier_required: 1, qualifier_emitted: 1 } },
        ],
      }),
    );

    // Assert
    expect(stdout).toContain(
      "PASS  pilot qualifiers  every answer that needed a coverage qualifier carried one (3 of 3)",
    );
  });

  test("no counted surface is 'not measured', never a clean bill", async () => {
    // Arrange & Act
    const stdout = await doctor(serving({}));

    // Assert
    expect(stdout).toContain("PASS  pilot qualifiers  not measured");
  });

  test("a rung that cannot exist here is a PASS line with its reason (PIL-8)", async () => {
    // Arrange & Act
    const stdout = await doctor(serving({}));

    // Assert — and a figure that is merely empty today is not a rung
    expect(stdout).toContain(
      "PASS  pilot ghost collisions  unavailable — a ghost line is never recorded as a delivery",
    );
    expect(stdout).toContain(
      "PASS  pilot ci regressed  unavailable — no CI reporter writes to this hub",
    );
    expect(stdout).not.toContain("nothing was flagged");
  });

  test("a hub too old for the report is 'not measured'", async () => {
    // Arrange & Act
    const stdout = await doctor(() =>
      Response.json(
        { ok: false, error: { code: "not_found", message: "no such route" } },
        { status: HTTP_NOT_FOUND },
      ),
    );

    // Assert
    expect(stdout).toContain("PASS  pilot  not measured (this hub has no pilot report)");
  });

  test("an answer that does not parse is 'not measured', not a WARN", async () => {
    // Arrange — the other hub-read lines' ladder: the parse is strict (a
    // missing count must not read as zero), and its refusal is a fact about
    // the answer, which is not an outage worth a WARN.
    const stdout = await doctor(() => Response.json({ ok: true, data: { sessions: [] } }));

    // Assert
    expect(stdout).toContain("PASS  pilot  not measured (this hub's answer did not parse)");
  });

  test("a hub that did not answer is a WARN that says nothing was learned", async () => {
    // Arrange & Act
    const stdout = await doctor(() =>
      Response.json(
        { ok: false, error: { code: "internal", message: "db is down" } },
        { status: HTTP_SERVER_ERROR },
      ),
    );

    // Assert
    expect(stdout).toContain("WARN  pilot  state unknown");
  });
});
