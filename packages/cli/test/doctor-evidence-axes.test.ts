/**
 * EV-7(b) — `repository_verified` unreachable is a DOCTOR LINE, never a
 * silence (1.0 spec 08 §3.5, §8.5; AT-10).
 *
 * WHY THIS LINE EXISTS AT ALL. Without it, two repositories look identical on
 * every surface in the product: one whose team's findings all failed
 * verification, and one where nothing could ever have checked them because
 * there is no CI reporter. Both print `tool_observed` for ever. A reader
 * comparing them concludes the second team's work does not hold up — which is
 * this project's own defect in one sentence, an absence being read as a
 * finding.
 *
 * TWO LEGS, REPORTED SEPARATELY, because the remedies are different people's
 * work: no CI coverage is a reporter to stand up (05), no claim commit binding
 * is a connector too old to send one (02).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { runDoctor } from "../src/cli/doctor.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const paths: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
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

interface HubAnswers {
  /** `unavailable` = this repo has no CI reporter at all. */
  readonly coverageState: string;
  readonly total: number;
  readonly unbound: number;
  /** When true the verdict route answers with an error rather than data. */
  readonly ciBroken?: boolean;
}

const hubWith = (answers: HubAnswers): string => {
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/ci-runs/verdict") {
        if (answers.ciBroken === true) {
          return Response.json(
            { ok: false, error: { code: "internal", message: "db is down" } },
            { status: HTTP_SERVER_ERROR },
          );
        }
        return Response.json({
          ok: true,
          data: {
            coverage: {
              state: answers.coverageState,
              lanesExpected: 0,
              lanesReported: 0,
              truncatedLanes: 0,
              awaitingRerun: 0,
              collectedAt: null,
            },
            deltas: [],
          },
        });
      }
      if (pathname === "/api/claim-revalidations/summary") {
        return Response.json({
          ok: true,
          data: {
            counted: answers.total,
            total: answers.total,
            unbound: answers.unbound,
            inferredBindings: 0,
            neverRevalidated: 0,
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

const report = async (answers: HubAnswers): Promise<string> => {
  const repo = await makeRepo("doctor-axes", {
    remote: "git@github.com:acme/api.git",
  });
  const home = await makeHome("doctor-axes");
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

describe("the evidence-axes doctor line", () => {
  test("a repo with no CI reporter is TOLD the rung is unreachable", async () => {
    // Arrange — `unavailable` is the state of every repo that has never
    // reported a run, and it stays that state until one does.
    const stdout = await report({
      coverageState: "unavailable",
      total: 4,
      unbound: 0,
    });

    // Assert — and the sentence says it is a limit of the SETUP, not a
    // judgement about the findings, because that is the conclusion a reader
    // reaches on their own when nobody tells them.
    expect(stdout).toContain("evidence axes");
    expect(stdout).toContain("repository_verified unreachable: no ci coverage");
    expect(stdout).toContain("limit of this setup");
  });

  test("a repo whose every claim is unbound is told which leg is missing", async () => {
    // Arrange — CI reports, but no claim names a commit, so there is nothing
    // to pair a run WITH.
    const stdout = await report({
      coverageState: "complete",
      total: 4,
      unbound: 4,
    });

    // Assert — the OTHER remedy, named separately: a connector to upgrade
    // rather than a reporter to stand up.
    expect(stdout).toContain(
      "repository_verified unreachable: no claim commit binding",
    );
  });

  test("ONE bound claim is enough — no warning at a repo that works", async () => {
    // Arrange — the case an `unbound > 0` check would have got wrong. Some
    // claims being unbound is ordinary; the rung is reachable as long as any
    // claim is bound, and warning here would be crying wolf.
    const stdout = await report({
      coverageState: "complete",
      total: 4,
      unbound: 3,
    });

    // Assert
    expect(stdout).not.toContain("repository_verified unreachable");
    expect(stdout).toContain("repository_verified is reachable");
  });

  test("an empty repo is not warned about a limitation it has not met", async () => {
    // Arrange — no claims at all. `unbound === total` is trivially true here,
    // and a check without the `total > 0` guard would WARN at every fresh
    // install, which trains a team to ignore the line.
    const stdout = await report({
      coverageState: "complete",
      total: 0,
      unbound: 0,
    });

    // Assert
    expect(stdout).not.toContain("repository_verified unreachable");
  });

  test("a hub outage is not reported twice as a second failure", async () => {
    // Arrange — the CI route errors. That already has its own line; repeating
    // it here would imply a second thing is wrong.
    const stdout = await report({
      coverageState: "complete",
      total: 4,
      unbound: 0,
      ciBroken: true,
    });

    // Assert — the CI line says it, and the axes line does not say it again.
    expect(stdout).toContain("ci coverage");
    expect(stdout).not.toContain("repository_verified unreachable");
  });

  test("the runtime refusal is stated, at every repo", async () => {
    // Arrange — §8.5: a profiler trace, flame graph and benchmark have NO
    // rung in 1.0. Somebody attaching one gets `ref_malformed` from the
    // ladder, and without this line they read that as a bug in their ref
    // rather than as a capability that does not exist.
    const stdout = await report({
      coverageState: "complete",
      total: 4,
      unbound: 0,
    });

    // Assert
    expect(stdout).toContain("runtime tool evidence: no_platform_rung");
  });
});
