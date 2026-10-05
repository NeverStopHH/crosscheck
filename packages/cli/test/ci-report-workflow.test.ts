/**
 * CI-1 — THE REPORTER SENDS THE HEAD SHA, NOT THE MERGE SHA (spec 05 §7).
 *
 * The hub holds no repository and cannot tell a merge sha from a head sha, so
 * no hub-side assertion can fail for this. The decision lives in ONE place —
 * the `--sha` expression of the reporter step in `.github/workflows/ci.yml` —
 * and this file is a string assertion over that YAML, stated as such rather
 * than dressed up as a hub property. `github.sha` on a `pull_request` event
 * is the merge commit, which no developer's history contains: a row keyed on
 * it joins zero sessions and reads exactly like "CI has not run yet".
 *
 * The same file holds the two other workflow facts the reporter depends on:
 * the test step must WRITE the junit file the reporter reads, and the
 * reporter step must run on a RED suite (`if: always()`), or a regression is
 * precisely the run that never gets reported.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { parseCiReportArgs } from "../src/ci-report/args.ts";

const WORKFLOW_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  ".github",
  "workflows",
  "ci.yml",
);
const HEAD_SHA_EXPRESSION =
  "--sha ${{ github.event.pull_request.head.sha || github.sha }}";
const BRANCH_REF_EXPRESSION = "--ref ${{ github.head_ref || github.ref_name }}";
const REPORTER_COMMAND = "bun run packages/cli/scripts/ci-report.ts";
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

/** The `test` job's text: from its key to the next job's. */
const testJob = (workflow: string): string => {
  const start = workflow.indexOf("\n  test:\n");
  const end = workflow.indexOf("\n  concurrency:\n");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("ci.yml no longer has a `test` job followed by `concurrency`");
  }
  return workflow.slice(start, end);
};

/** The reporter step's command line, with every expression substituted. */
const reporterArgv = (job: string): readonly string[] => {
  const start = job.indexOf(REPORTER_COMMAND);
  const end = job.indexOf("\n        env:", start);
  if (start < 0 || end < 0) {
    throw new Error("the reporter step or its env block is missing");
  }
  return job
    .slice(start + REPORTER_COMMAND.length, end)
    .replace("${{ matrix.os }}", "ubuntu-latest")
    .replace("${{ github.head_ref || github.ref_name }}", "feat/login-retry")
    .replace("${{ github.run_attempt }}", "1")
    .replace("${{ github.run_id }}", "35572434868")
    .replace("${{ github.event.pull_request.head.sha || github.sha }}", HEAD_SHA)
    .split(/\s+/)
    .filter((token) => token.length > 0);
};

const workflow = await Bun.file(WORKFLOW_PATH).text();
const job = testJob(workflow);

describe("CI-1: the reporter step resolves the head sha", () => {
  test("the --sha argument prefers the pull request's head sha and falls back to github.sha", () => {
    expect(job).toContain(HEAD_SHA_EXPRESSION);
  });

  test("no step sends github.sha alone", () => {
    expect(job).not.toContain("--sha ${{ github.sha }}");
  });

  test("the --ref argument is the branch: a pull request's head ref, else the pushed ref", () => {
    // `github.ref_name` on a pull_request event is `<n>/merge`, not the branch
    // spec 05 §3.1 says `ref` is — the ref-side twin of the merge-sha mistake.
    expect(job).toContain(BRANCH_REF_EXPRESSION);
    expect(job).not.toContain("--ref ${{ github.ref_name }}");
  });

  test("the command line as written parses, and the sha it resolves is the one that is posted", () => {
    // The reporter's own parser over the workflow's own tokens: the sha in
    // `args` is what buildCiRunReport puts in `commitSha`, byte for byte.
    const parsed = parseCiReportArgs(reporterArgv(job));

    expect(parsed.kind).toBe("args");
    if (parsed.kind === "args") {
      expect(parsed.args.commitSha).toBe(HEAD_SHA);
      expect(parsed.args.job).toBe("test");
      expect(parsed.args.leg).toBe("ubuntu-latest");
      expect(parsed.args.ref).toBe("feat/login-retry");
      expect(parsed.args.runAttempt).toBe(1);
      expect(parsed.args.externalRunId).toBe("35572434868");
      expect(parsed.args.junitPath).toBe("junit.xml");
    }
  });
});

describe("the workflow feeds the reporter", () => {
  test("the test step writes the junit file the reporter reads", () => {
    expect(job).toContain(
      "- run: bun test --reporter=junit --reporter-outfile=junit.xml",
    );
  });

  test("the reporter step runs on a red suite too — `if: always()`", () => {
    // A regression is precisely the run that must be reported, and every
    // step after a failed `bun test` is skipped unless it says otherwise.
    const step = job.slice(
      job.indexOf("- name: Report"),
      job.indexOf(REPORTER_COMMAND),
    );

    expect(step).toContain("if: always()");
  });

  test("the hub facts come from repository secrets, so a fork pull request has none", () => {
    expect(job).toContain(
      "CROSSCHECK_HUB_URL: ${{ secrets.CROSSCHECK_HUB_URL }}",
    );
    expect(job).toContain(
      "CROSSCHECK_CI_TOKEN: ${{ secrets.CROSSCHECK_CI_TOKEN }}",
    );
  });

  test("the step is inside the matrix job, so both legs report as two lanes (D3)", () => {
    expect(job).toContain("--leg ${{ matrix.os }}");
    expect(job).toContain("--job test");
  });
});
