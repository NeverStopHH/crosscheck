/**
 * The CI reporter is reachable as `crosscheck ci-report` from the published
 * package, not only as a script inside this repository — another team's CI
 * has no `packages/cli/scripts/` to run. Both entries must behave alike, so
 * this spawns each as a real process with the same input and compares what a
 * CI log would show.
 *
 * The input is the "no token" path every repository without a configured hub
 * takes: one line, exit 0, nothing sent — no network in this test.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { EXIT_OK, EXIT_USAGE } from "@crosscheck/connector-core/constants.ts";

import { CI_REPORT_USAGE } from "../src/ci-report/args.ts";
import { ciReportOutcome } from "../src/ci-report/entry.ts";

const BIN_PATH = resolve(import.meta.dir, "..", "src", "bin", "crosscheck.ts");
const SCRIPT_PATH = resolve(import.meta.dir, "..", "scripts", "ci-report.ts");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const ONE_GREEN_TEST = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="1" failures="0" skipped="0" time="0.01">
  <testsuite name="probe.test.ts" file="probe.test.ts" tests="1" failures="0" skipped="0" time="0.01">
    <testcase name="passes" classname="probe" time="0.001" file="probe.test.ts" />
  </testsuite>
</testsuites>
`;
const ARGS = [
  "--junit", "junit.xml", "--job", "test", "--leg", "ubuntu-latest",
  "--ref", "feat/x", "--attempt", "1", "--run-id", "123", "--sha", SHA,
];
const RUNNER_ENV = {
  GITHUB_REPOSITORY: "acme/api",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_WORKFLOW: "CI",
  CROSSCHECK_HUB_URL: "",
  CROSSCHECK_CI_TOKEN: "",
};

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Outcome {
  readonly stdout: string;
  readonly exitCode: number;
}

const run = async (cmd: readonly string[], env: Record<string, string>): Promise<Outcome> => {
  const cwd = await mkdtemp(join(tmpdir(), "cx-ci-entry-"));
  dirs.push(cwd);
  await writeFile(join(cwd, "junit.xml"), ONE_GREEN_TEST);
  const child = Bun.spawn({
    cmd: [...cmd],
    cwd,
    env: { PATH: process.env["PATH"] ?? "", HOME: cwd, ...env },
    stdout: "pipe",
    stderr: "ignore",
  });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { stdout, exitCode };
};

describe("the CI reporter's two entries", () => {
  test("`crosscheck ci-report` says the run was not reported and exits 0 without a token", async () => {
    const outcome = await run([process.execPath, BIN_PATH, "ci-report", ...ARGS], RUNNER_ENV);
    expect(outcome.exitCode).toBe(EXIT_OK);
    expect(outcome.stdout).toContain("not reported");
  });

  test("the command and the repository script print the same and exit the same", async () => {
    const [command, script] = await Promise.all([
      run([process.execPath, BIN_PATH, "ci-report", ...ARGS], RUNNER_ENV),
      run([process.execPath, SCRIPT_PATH, ...ARGS], RUNNER_ENV),
    ]);
    expect(command).toEqual(script);
  });

  test("off a CI runner the command refuses as a usage error, like the script", async () => {
    const [command, script] = await Promise.all([
      run([process.execPath, BIN_PATH, "ci-report", ...ARGS], {}),
      run([process.execPath, SCRIPT_PATH, ...ARGS], {}),
    ]);
    expect(command.exitCode).toBe(EXIT_USAGE);
    expect(command).toEqual(script);
  });

  test("`crosscheck ci-report --help` answers with the reporter's usage, not the CLI's", async () => {
    const outcome = await run([process.execPath, BIN_PATH, "ci-report", "--help"], RUNNER_ENV);
    expect(outcome).toEqual({ stdout: CI_REPORT_USAGE, exitCode: EXIT_OK });
  });

  test("the CLI's own usage names the command, so `crosscheck --help` shows where it went", async () => {
    const outcome = await run([process.execPath, BIN_PATH, "--help"], RUNNER_ENV);
    expect(outcome.stdout).toContain("  ci-report --junit <file>");
  });
});

describe("the reporter never turns a CI job red for its own sake", () => {
  test("a throw inside the reporter is one sentence and exit 0, and says the run is not recorded", async () => {
    const outcome = await ciReportOutcome(["--junit", "junit.xml"], {}, "/", () =>
      Promise.reject(new Error("junit parser exploded")),
    );
    expect(outcome.exitCode).toBe(EXIT_OK);
    expect(outcome.stdout).toBe(
      "ci-report: internal failure (junit parser exploded) — this run is not recorded; coverage.ci stays unknown at this commit\n",
    );
  });

  test("a usage error is passed through as exit 64 — the workflow author's mistake must surface", async () => {
    const outcome = await ciReportOutcome([], {}, "/", () =>
      Promise.resolve({ stdout: "usage\n", exitCode: EXIT_USAGE }),
    );
    expect(outcome).toEqual({ stdout: "usage\n", exitCode: EXIT_USAGE });
  });
});
