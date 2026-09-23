/**
 * VER-8's second half — a withheld verdict is REPORTED, not merely withheld
 * (1.0 spec 04 §3.7; non-negotiable #4).
 *
 * `computeVerdict` fails closed when it meets one of the nine illegal
 * combinations: the answer degrades to `INDETERMINATE` / `legality_violation`
 * and drops its rows. That half is asserted in `server/test/verdict.test.ts`.
 * It is not enough. A downgrade nobody is told about hides the bug that caused
 * it — the hub keeps answering, every surface keeps rendering, and the only
 * trace is a verdict that quietly says "cannot tell" for ever, which reads
 * exactly like an ordinary blind spot. So `doctor` asks about a real pin and
 * says what came back.
 *
 * THE LADDER IS #50's, and the distinctions are the point: a repo with no pins
 * has nothing to check (PASS, *not measured*); a hub that did not answer has
 * told us nothing (WARN, *could not reach*); a hub that reports no verdict at
 * all is older than this spec and is also *not measured* — saying PASS there
 * would report "verdicts here are legal" about a hub that computes none.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { runDoctor } from "../src/cli/doctor.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const paths: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
const HTTP_SERVER_ERROR = 500;

const PIN = "pin_11111111-2222-4333-8444-555555555555";
const ISO = "2026-09-12T09:00:00.000Z";

afterEach(async () => {
  for (const server of servers) {
    server.stop(true);
  }
  servers.length = 0;
  await Promise.all(
    paths.map((path) => rm(path, { recursive: true, force: true })),
  );
  paths.length = 0;
});

interface HubAnswers {
  /** No pins at all — the "nothing to check" rung. */
  readonly noPins?: boolean;
  /** The suspect route answers with an error rather than data. */
  readonly suspectBroken?: boolean;
  /** A hub older than this spec: a ranking with no verdict beside it. */
  readonly noVerdict?: boolean;
  /** What the verdict's basis says, when there is one. */
  readonly basis?: string;
}

const pinRow = {
  id: PIN,
  repo: "github.com/acme/api",
  surface: "playback keeps working",
  files: [{ path: "src/player.ts", status: "present" }],
  check: "bun test",
  captureMode: "human",
  verifiedById: "dev_nick",
  verifiedByName: "Nick",
  verifiedAtCommit: "a1b2c3d",
  verifiedAt: ISO,
  brokeAt: null,
  brokeByName: null,
  speaking: true,
  missingPaths: 0,
  renamedPaths: 0,
  renamedAt: null,
  renamedByName: null,
  liveWaiver: null,
};

const suspectBody = (answers: HubAnswers): Record<string, unknown> => ({
  outcome: "no_touch",
  falsifier: { kind: "recorded_break", at: ISO, check: "bun test" },
  scope: {
    kind: "pin",
    pinId: PIN,
    surface: "playback keeps working",
    files: ["src/player.ts"],
    missingFiles: [],
    rewrittenPaths: 0,
    rewrittenAt: null,
  },
  totals: { sessionsTouching: 0, sessionsScored: 0, windowDays: 14 },
  attribution: "sessions",
  candidates: [],
  ...(answers.noVerdict === true
    ? {}
    : {
        verdict: {
          attribution: "INDETERMINATE",
          protection: "unprotected",
          basis: answers.basis ?? "coverage_gap",
          falsifier: "recorded_break",
          behaviorDelta: "unconfirmed",
          deltaLane: "pin",
          deltaReason: "human_recheck_unrepeated",
          explanationTiming: "absent",
          timingReason: "no_intent",
          invariant: { pinId: PIN, version: 1 },
          waiver: null,
          computedAt: ISO,
        },
      }),
});

const hubWith = (answers: HubAnswers): string => {
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/pins") {
        return Response.json({
          ok: true,
          data: {
            pins: answers.noPins === true ? [] : [pinRow],
            coverage: {
              pins: answers.noPins === true ? 0 : 1,
              files: answers.noPins === true ? 0 : 1,
              speaking: 0,
              broken: 0,
              missingPaths: 0,
              oldestVerifiedAt: answers.noPins === true ? null : ISO,
            },
          },
        });
      }
      if (pathname === "/api/suspect") {
        return answers.suspectBroken === true
          ? Response.json(
              { ok: false, error: { code: "internal", message: "db is down" } },
              { status: HTTP_SERVER_ERROR },
            )
          : Response.json({ ok: true, data: suspectBody(answers) });
      }
      if (pathname === "/api/work-contexts") {
        return Response.json({ ok: true, data: { workContexts: [] } });
      }
      return Response.json({ ok: true, data: { sessions: [] } });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${String(server.port)}`;
};

const report = async (answers: HubAnswers): Promise<string> => {
  const repo = await makeRepo("doctor-verdict", {
    remote: "git@github.com:acme/api.git",
  });
  const home = await makeHome("doctor-verdict");
  paths.push(repo, home);
  const result = await runDoctor(
    {
      CROSSCHECK_HOME: home,
      HOME: home,
      CROSSCHECK_HUB_URL: hubWith(answers),
      CROSSCHECK_API_KEY: "test-key",
    },
    repo,
    async () => null,
  );
  return result.stdout;
};

describe("the verdict-legality doctor line", () => {
  test("a hub that withheld a verdict is REPORTED as a FAIL", async () => {
    // Arrange — the hub met an illegal combination and degraded. This is the
    // case the whole rung exists for.
    const stdout = await report({ basis: "legality_violation" });

    // Assert — and the sentence places the blame correctly. A reader who
    // thinks their REPO is misconfigured goes looking in the wrong place.
    expect(stdout).toContain("FAIL");
    expect(stdout).toContain("verdict legality");
    expect(stdout).toContain("a defect in the hub, not in this repo");
  });

  test("a legal verdict passes, and the line says how much it checked", async () => {
    // Arrange — one pin, and the detail must not imply a sweep.
    const stdout = await report({ basis: "coverage_gap" });

    // Assert
    expect(stdout).toContain("verdict legality");
    expect(stdout).toContain("checked 1 of 1 pin(s)");
    expect(stdout).toContain("legal combination");
    expect(stdout).not.toContain("FAIL  verdict legality");
  });

  test("no pins is 'not measured', never a green about nothing", async () => {
    // Arrange & Act
    const stdout = await report({ noPins: true });

    // Assert — a repo with no pins has no verdict to be wrong about, and a
    // PASS that read like a judgement would be the fail-silent shape.
    expect(stdout).toContain("not measured (no pins on this repo");
  });

  test("a hub that did not answer is a WARN, not a pass", async () => {
    // Arrange — #50's ladder: a green meaning "could not check" is worse than
    // no check at all.
    const stdout = await report({ suspectBroken: true });

    // Assert
    expect(stdout).toContain("WARN");
    expect(stdout).toContain("could not reach a verdict");
    expect(stdout).toContain(
      "says nothing about whether verdicts here are legal",
    );
  });

  test("a hub that reports no verdict is 'not measured' too", async () => {
    // Arrange — an older 1.0 hub. PASSing with a legality sentence here would
    // report that verdicts on this hub are legal, about a hub computing none.
    const stdout = await report({ noVerdict: true });

    // Assert
    expect(stdout).toContain("not measured (this hub reports no verdict");
  });
});
