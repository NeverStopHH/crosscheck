/**
 * THE TWO REFUSALS SPEC 02 OWES DOCTOR (§8.5, §8.9) — and the reason they are
 * refusals rather than silence.
 *
 * §8.5: a claim whose `commit_binding` is `none` has no "from" commit, so the
 * revalidation rung cannot exist for it — ever. That claim is permanently
 * pointer-only, and AT-10's rule is that a rung a platform genuinely cannot
 * serve appears as a DOCUMENTED REFUSAL, never as a silent absence. Without a
 * line naming the count and the cause, a team whose sessions register no
 * usable commit reads a clean report while none of their knowledge can ever
 * be judged current.
 *
 * §8.9: nothing revalidates on CI or at runtime in 1.0. Currency is measured
 * where somebody asks for it — a `get_diagnosis` pull, or `crosscheck
 * revalidate`. A repo nobody pulls from reads `unknown` forever, which is the
 * honest answer and a useless one unless a surface says it out loud (D5's
 * named cost).
 *
 * THE OLD-HUB SHAPE IS checkPins' VERBATIM. A hub that 404s the summary is a
 * hub that predates it and says nothing about this install: PASS, "not
 * measured". A hub that could not be REACHED is a WARN, because a green
 * meaning "could not check" is worse than no check at all.
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
  await Promise.all(
    paths.map((path) => rm(path, { recursive: true, force: true })),
  );
  paths.length = 0;
});

interface Summary {
  readonly counted: number;
  readonly total: number;
  readonly unbound: number;
  readonly neverRevalidated: number;
  readonly states: Record<string, number>;
}

const STATES = {
  current: 10,
  stale: 0,
  superseded: 0,
  invalidated: 0,
  unknown: 0,
};

const summary = (overrides: Partial<Summary> = {}): Summary => ({
  counted: 10,
  total: 10,
  unbound: 0,
  neverRevalidated: 0,
  states: STATES,
  ...overrides,
});

/** null = a hub too old to know the route; "unreachable" = a hub that broke. */
const hubWith = (answer: Summary | null | "unreachable"): string => {
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/claim-revalidations/summary") {
        if (answer === null) {
          return Response.json(
            { ok: false, error: { code: "not_found", message: "unknown route" } },
            { status: HTTP_NOT_FOUND },
          );
        }
        if (answer === "unreachable") {
          return Response.json(
            { ok: false, error: { code: "internal", message: "database is down" } },
            { status: HTTP_SERVER_ERROR },
          );
        }
        return Response.json({ ok: true, data: answer });
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

const report = async (
  answer: Summary | null | "unreachable",
): Promise<string> => {
  const repo = await makeRepo("doctor-binding", {
    remote: "git@github.com:acme/api.git",
  });
  const home = await makeHome("doctor-binding");
  paths.push(repo, home);
  const hubUrl = hubWith(answer);
  const result = await runDoctor(
    {
      CROSSCHECK_HOME: home,
      HOME: home,
      CROSSCHECK_HUB_URL: hubUrl,
      CROSSCHECK_API_KEY: "test-key",
    },
    repo,
    async () => null,
  );
  return result.stdout;
};

const lineWith = (stdout: string, needle: string): string =>
  stdout.split("\n").find((line) => line.includes(needle)) ?? "";

describe("a claim that can never be revalidated is named, not absent", () => {
  test("the count and the reason both reach the report", async () => {
    // Arrange: §8.5. Three of this repo's claims were written by sessions
    // that registered no usable commit — the NO_COMMIT_SHA placeholder, or a
    // label like `crosscheck conference`'s "conference".
    const stdout = await report(
      summary({
        unbound: 3,
        states: { ...STATES, current: 7, unknown: 3 },
      }),
    );

    // Assert: a WARN that says how many and why, because the remedy is not
    // "run revalidate" — it is that these claims have nothing to revalidate
    // against and never will.
    const line = lineWith(stdout, "claim binding");
    expect(line).toContain("WARN");
    expect(line).toContain("3 of 10");
    expect(line).toContain("never");
  });

  test("a repo whose claims are all bound says so without a warning", async () => {
    // Arrange: the steady state. A line that warns on every healthy install
    // is one nobody reads.
    const stdout = await report(summary());

    // Assert
    const line = lineWith(stdout, "claim binding");
    expect(line).toContain("PASS");
    expect(line).toContain("10");
  });

  test("a hub too old to answer is not measured, and is not health", async () => {
    // Arrange: checkPins' shape verbatim — an older hub says NOTHING about
    // this install, which is a PASS that states its own ignorance.
    const stdout = await report(null);

    // Assert
    const line = lineWith(stdout, "claim binding");
    expect(line).toContain("PASS");
    expect(line).toContain("not measured");
  });

  test("a hub that could not answer is a warning, never a green", async () => {
    // Arrange: the OTHER failure, and the one a single "not measured" branch
    // would hide. A green meaning "could not check" is worse than no check.
    const stdout = await report("unreachable");

    // Assert
    const line = lineWith(stdout, "claim binding");
    expect(line).toContain("WARN");
    expect(line).toContain("unknown");
  });
});

describe("nothing revalidates on its own, and the report says so", () => {
  test("the never-revalidated count names what would measure it", async () => {
    // Arrange: §8.9 and D5's named cost. Six claims in this repo have never
    // been checked against the code, and no CI job and no runtime signal will
    // ever check them — the two things that would are a `get_diagnosis` pull
    // and `crosscheck revalidate`.
    const stdout = await report(
      summary({
        neverRevalidated: 6,
        states: { ...STATES, current: 4, unknown: 6 },
      }),
    );

    // Assert
    const line = lineWith(stdout, "claim currency");
    expect(line).toContain("6 of 10");
    expect(line).toContain("revalidate");
  });

  test("a downgrade already measured is reported as a number, not a worry", async () => {
    // Arrange: stale claims are the system WORKING. The line reports them
    // without a warning, because a team whose knowledge is being judged
    // against its code is the state this spec exists to produce.
    const stdout = await report(
      summary({
        states: {
          current: 6,
          stale: 3,
          superseded: 1,
          invalidated: 0,
          unknown: 0,
        },
      }),
    );

    // Assert
    const line = lineWith(stdout, "claim currency");
    expect(line).toContain("PASS");
    expect(line).toContain("3 stale");
  });
});
