/**
 * SPEC 05 §8's REFUSALS, AS DOCTOR LINES — never as silences.
 *
 * Nine things this spec will not do. The ones a reader could mistake for a
 * working feature are the ones that must appear on a surface, because each
 * absence looks exactly like good news:
 *
 *   - a repo whose CI reports nothing looks like a repo whose CI is green;
 *   - a GitLab team waits forever for rows no reporter exists to send;
 *   - a fork pull request's silence reads as a passing suite.
 *
 * AT-10 calls a rung a platform genuinely cannot serve a DOCUMENTED REFUSAL,
 * never a silent absence, and that is what these lines are.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { CI_KNOWN_PROVIDERS, CI_PROVIDERS } from "@crosscheck/schema";

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

interface Coverage {
  readonly state: string;
  readonly lanesExpected?: number;
  readonly lanesReported?: number;
  readonly truncatedLanes?: number;
  readonly awaitingRerun?: number;
}

/** A hub that answers the verdict route with this, and everything else empty. */
const hubWith = (answer: Coverage | null | "broken"): string => {
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/ci-runs/verdict") {
        if (answer === null) {
          return Response.json(
            { ok: false, error: { code: "not_found", message: "no route" } },
            { status: HTTP_NOT_FOUND },
          );
        }
        if (answer === "broken") {
          return Response.json(
            {
              ok: false,
              error: { code: "internal", message: "database is down" },
            },
            { status: HTTP_SERVER_ERROR },
          );
        }
        return Response.json({
          ok: true,
          data: {
            coverage: {
              lanesExpected: 0,
              lanesReported: 0,
              truncatedLanes: 0,
              awaitingRerun: 0,
              collectedAt: null,
              ...answer,
            },
            deltas: [],
          },
        });
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

const report = async (answer: Coverage | null | "broken"): Promise<string> => {
  const repo = await makeRepo("doctor-ci", {
    remote: "git@github.com:acme/api.git",
  });
  const home = await makeHome("doctor-ci");
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

const lineWith = (stdout: string, needle: string): string =>
  stdout.split("\n").find((line) => line.includes(needle)) ?? "";

describe("a repo with no CI is told so, not left to assume", () => {
  test("unavailable is a PASS that says nothing about the tests", async () => {
    // NOT A FAILURE. A repo with no reporter has nothing to be incomplete
    // about, and the remedy is a decision rather than a fix — so a WARN here
    // would be a nag about a choice nobody made wrong.
    const line = lineWith(await report({ state: "unavailable" }), "ci coverage");

    expect(line.startsWith("PASS")).toBe(true);
    expect(line).toContain("no CI reporter is configured");
    expect(line).toContain("says nothing about your tests");
  });

  test("a commit nothing has arrived for is unknown, never green", async () => {
    const line = lineWith(await report({ state: "unknown" }), "ci coverage");

    expect(line).toContain("nothing has arrived for this commit yet");
    expect(line).toContain("unknown");
  });
});

describe("an incomplete answer is a warning, with its counts", () => {
  test("silent lanes are counted and the level says to look", async () => {
    const line = lineWith(
      await report({ state: "incomplete", lanesExpected: 3, lanesReported: 1 }),
      "ci coverage",
    );

    expect(line.startsWith("WARN")).toBe(true);
    expect(line).toContain("1 of 3 expected lanes reported");
  });

  test("a truncated run is named as unable to establish anything", async () => {
    // A run that filled the row cap can never establish that any test was
    // green, so "it reported" is true and misleading on its own.
    const line = lineWith(
      await report({
        state: "incomplete",
        lanesExpected: 1,
        lanesReported: 1,
        truncatedLanes: 1,
      }),
      "ci coverage",
    );

    expect(line).toContain("truncated or crashed");
    expect(line).toContain("cannot establish that any test was green");
  });

  test("a verdict waiting on a re-run is named rather than counted as failure", async () => {
    const line = lineWith(
      await report({
        state: "incomplete",
        lanesExpected: 1,
        lanesReported: 1,
        awaitingRerun: 2,
      }),
      "ci coverage",
    );

    expect(line).toContain("2 non-green test(s) waiting on a re-run");
    expect(line).toContain("before anything can be concluded");
  });
});

describe("the refusals are printed, and derived rather than remembered", () => {
  test("an unserved provider is named with its reason", async () => {
    // §8.1. GitLab is `unavailable` because the rung that decides the design
    // — whether a retried job carries a verifiable attempt number on the same
    // commit — cannot be confirmed without an instance to measure. Designing
    // against an unverified platform fact is the pretending this project
    // refuses, and saying so beats a silence a team reads as "not set up yet".
    const line = lineWith(await report({ state: "unknown" }), "ci provider");

    expect(line).toContain("gitlab_ci");
    expect(line).toContain("has no reporter");
  });

  test("the unserved list is the difference between two lists, not prose", async () => {
    // THE SENTENCE CANNOT OUTLIVE THE FACT. The day a provider ships it moves
    // into CI_PROVIDERS and the line stops printing because the list grew —
    // not because somebody remembered to delete a paragraph. This is the
    // assertion that keeps that true.
    const served: readonly string[] = CI_PROVIDERS;
    const unserved = CI_KNOWN_PROVIDERS.filter(
      (provider) => !served.includes(provider),
    );
    const stdout = await report({ state: "unknown" });

    expect(unserved.length).toBeGreaterThan(0);
    for (const provider of unserved) {
      expect(lineWith(stdout, "ci provider")).toContain(provider);
    }
    for (const provider of served) {
      expect(lineWith(stdout, "ci provider")).not.toContain(provider);
    }
  });

  test("the two silent-reporter cases are named on their own line", async () => {
    // §8.2 and §8.3. A laptop run happens at an unknown sha in a dirty
    // worktree; a fork pull request gets no repository secrets, so its
    // reporter has no hub token. Both produce NO rows, and no rows is what a
    // green suite also produces.
    const line = lineWith(
      await report({ state: "unknown" }),
      "ci reporting gaps",
    );

    expect(line).toContain("never recorded as CI");
    expect(line).toContain("fork pull request");
    expect(line).toContain("rather than as a green suite");
  });
});

describe("a hub that cannot answer is not a hub that said yes", () => {
  test("an older hub is PASS and not measured", async () => {
    // A 404 is a hub that predates the route and says nothing about this
    // install — the shape `checkPins` already uses for the same situation.
    const line = lineWith(await report(null), "ci coverage");

    expect(line.startsWith("PASS")).toBe(true);
    expect(line).toContain("this hub does not ingest CI");
  });

  test("a broken hub is a WARN, and its words are bounded", async () => {
    // A green meaning "could not check" is worse than no check at all. And
    // the hub's own sentence is somebody else's text: `crosscheck doctor` is
    // registered as interpolating nothing untrusted, which was true of every
    // sentence it writes and false of the ones it passes through.
    const line = lineWith(await report("broken"), "ci coverage");

    expect(line.startsWith("WARN")).toBe(true);
    expect(line).toContain("the hub did not answer");
    expect(line).toContain("says nothing about whether your tests passed");
  });
});
