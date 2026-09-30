/**
 * THE REPORTER (spec 05 §3.7, §8, §10 D4): one CI job's result, keyed to a
 * commit, posted to the hub — and, when the suite is red, one re-run of the
 * failed files on the same runner so the hub can tell a flake from a
 * regression.
 *
 * ORDER OF REFUSALS, and why each exits the way it does:
 *
 *   1. argv the workflow author got wrong → usage, EXIT_USAGE. Deterministic,
 *      visible on the first run, fixed once. Never a flake.
 *   2. not a GitHub Actions runner (no GITHUB_REPOSITORY / GITHUB_WORKFLOW)
 *      → usage, EXIT_USAGE. A laptop run happens at an unknown sha in a dirty
 *      worktree and is never recorded as CI (§8.2).
 *   3. no token, no hub url, a hub url that is not http(s) → ONE line, EXIT_OK.
 *      A fork pull request has no repository secrets (§8.3), and the reporter
 *      must never turn a green job red: inform, never block.
 *   4. the hub unreachable, refusing, or answering nonsense → one line,
 *      EXIT_OK, and NO re-run: a re-run row names the primary it repeats, and
 *      there is nothing to name.
 *
 * A JUNIT FILE THAT IS MISSING OR HALF-WRITTEN IS A `crashed` ROW, not a
 * skipped report. The lane RAN — the job exists, the step is executing — and
 * said nothing about any test; the hub must see that, because from outside a
 * lane that crashed and a lane that never reported look the same and mean
 * different things (§2, principle 4).
 *
 * THE RE-RUN IS BY FILE, ON THIS RUNNER, and recorded as `same_job` rather
 * than as a fresh attempt because it shares the runner's state — a host-level
 * flake survives it, which is why the kind is on the wire (§10 D2). Its exit
 * code is ignored on purpose: a red re-run exits 1 by design, and the XML is
 * the answer.
 *
 * NOTHING HERE READS `~/.crosscheck`. The runner belongs to nobody on the
 * team; every fact comes from argv, from the runner's environment, and from
 * the junit file.
 */
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import { EXIT_OK, EXIT_USAGE } from "@crosscheck/connector-core/constants.ts";

import type { CliResult } from "../cli/login.ts";
import { CI_REPORT_USAGE, parseCiReportArgs, readCiReportEnv } from "./args.ts";
import type { CiReportArgs } from "./args.ts";
import { parseJunit } from "./junit.ts";
import type { JunitRun } from "./junit.ts";
import { postCiRun } from "./post.ts";
import type { CiReportFetch, CiRunPostOutcome } from "./post.ts";
import { buildCiRunReport, buildCrashedCiRunReport } from "./report.ts";
import type {
  BuiltCiRunReport,
  CiReportLane,
  CiReportRerun,
} from "./report.ts";
import {
  ciReportHubFailureLine,
  ciReportNotReportedLine,
  ciReportRunLine,
} from "./render.ts";
import type { CiReportStage } from "./render.ts";

export type { CiReportFetch } from "./post.ts";

/** Runs the named test files and writes their junit report to `outfile` (cwd-relative). */
export type RunTests = (
  cwd: string,
  files: readonly string[],
  outfile: string,
) => Promise<void>;

export interface CiReportDeps {
  readonly fetch: CiReportFetch;
  readonly runTests: RunTests;
  readonly now: () => Date;
}

const HTTP_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:"]);

/**
 * `process.execPath` is the bun that is running this script, so the re-run
 * uses the same runtime the primary did — never whichever `bun` is first on
 * PATH. Output is inherited: the re-run's console text belongs in the CI
 * log exactly as the primary's does.
 */
const spawnBunTest: RunTests = async (cwd, files, outfile) => {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "test",
      "--reporter=junit",
      `--reporter-outfile=${outfile}`,
      ...files,
    ],
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  await child.exited;
};

const DEFAULT_DEPS: CiReportDeps = {
  fetch: (url, init) => fetch(url, init),
  runTests: spawnBunTest,
  now: () => new Date(),
};

const usageError = (message: string): CliResult => ({
  stdout: `ci-report: ${message}\n${CI_REPORT_USAGE}`,
  exitCode: EXIT_USAGE,
});

const done = (lines: readonly string[]): CliResult => ({
  stdout: lines.join(""),
  exitCode: EXIT_OK,
});

const isHttpUrl = (raw: string): boolean => {
  try {
    return HTTP_SCHEMES.has(new URL(raw).protocol);
  } catch {
    return false;
  }
};

type JunitRead =
  | { readonly kind: "run"; readonly run: JunitRun; readonly writtenAt: Date }
  | { readonly kind: "unreadable"; readonly reason: string };

const readJunit = async (path: string): Promise<JunitRead> => {
  try {
    const { mtime } = await stat(path);
    const parsed = parseJunit(await Bun.file(path).text());
    return parsed.ok
      ? { kind: "run", run: parsed.run, writtenAt: mtime }
      : { kind: "unreadable", reason: parsed.reason };
  } catch (error) {
    return {
      kind: "unreadable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};

const buildFor = (
  read: JunitRead,
  lane: CiReportLane,
  rerun: CiReportRerun,
  collectedAt: Date,
): BuiltCiRunReport =>
  read.kind === "run"
    ? buildCiRunReport({
        run: read.run,
        lane,
        rerun,
        junitWrittenAt: read.writtenAt,
        collectedAt,
      })
    : {
        body: buildCrashedCiRunReport({ lane, rerun, collectedAt }),
        failedFiles: [],
        nonGreen: 0,
      };

const runLine = (
  lane: CiReportLane,
  built: BuiltCiRunReport,
  stage: CiReportStage,
  rerunFiles: number,
  stored: Extract<CiRunPostOutcome, { kind: "stored" }>,
): string =>
  ciReportRunLine({
    commitSha: lane.commitSha,
    job: lane.job,
    leg: lane.leg,
    runAttempt: lane.runAttempt,
    stage,
    rerunFiles,
    tests: built.body.tests,
    failures: built.body.failures,
    skipped: built.body.skipped,
    rowsSent: built.body.results.length,
    nonGreen: built.nonGreen,
    ambiguousDropped: built.body.ambiguousDropped,
    outcome: built.body.outcome,
    stored: { status: stored.status, id: stored.id },
  });

interface Hub {
  readonly url: string;
  readonly token: string;
}

interface Run {
  readonly deps: CiReportDeps;
  readonly cwd: string;
  readonly args: CiReportArgs;
  readonly lane: CiReportLane;
  readonly hub: Hub;
}

const reportRerun = async (
  run: Run,
  primaryId: string,
  failedFiles: readonly string[],
): Promise<string> => {
  const { deps, cwd, args, lane, hub } = run;
  await deps.runTests(cwd, failedFiles, args.rerunJunitPath);
  const rerun: CiReportRerun = { kind: "same_job", of: primaryId };
  const built = buildFor(
    await readJunit(resolve(cwd, args.rerunJunitPath)),
    lane,
    rerun,
    deps.now(),
  );
  const posted = await postCiRun(deps.fetch, hub.url, hub.token, built.body);
  return posted.kind === "stored"
    ? runLine(lane, built, "same_job", failedFiles.length, posted)
    : ciReportHubFailureLine(lane.commitSha, "same_job", posted);
};

const reportPrimary = async (run: Run): Promise<CliResult> => {
  const { deps, cwd, args, lane, hub } = run;
  const primary = buildFor(
    await readJunit(resolve(cwd, args.junitPath)),
    lane,
    { kind: "none" },
    deps.now(),
  );
  const posted = await postCiRun(deps.fetch, hub.url, hub.token, primary.body);
  if (posted.kind !== "stored") {
    return done([ciReportHubFailureLine(lane.commitSha, "primary", posted)]);
  }
  const first = runLine(lane, primary, "primary", 0, posted);
  if (primary.failedFiles.length === 0) {
    return done([first]);
  }
  return done([first, await reportRerun(run, posted.id, primary.failedFiles)]);
};

export const runCiReport = async (
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
  deps: CiReportDeps = DEFAULT_DEPS,
): Promise<CliResult> => {
  const parsed = parseCiReportArgs(argv);
  if (parsed.kind === "help") {
    return { stdout: CI_REPORT_USAGE, exitCode: EXIT_OK };
  }
  if (parsed.kind === "error") {
    return usageError(parsed.message);
  }
  const facts = readCiReportEnv(env);
  if (facts.repo === null) {
    return usageError(
      "GITHUB_REPOSITORY is not set — this is not a GitHub Actions runner, and a local `bun test` is never recorded as CI (unknown sha, dirty worktree)",
    );
  }
  if (facts.workflow === null) {
    return usageError(
      "GITHUB_WORKFLOW is not set — this is not a GitHub Actions runner",
    );
  }
  const sha = parsed.args.commitSha;
  if (facts.token === null) {
    return done([ciReportNotReportedLine(sha, "no_token")]);
  }
  if (facts.hubUrl === null) {
    return done([ciReportNotReportedLine(sha, "no_hub_url")]);
  }
  if (!isHttpUrl(facts.hubUrl)) {
    return done([ciReportNotReportedLine(sha, "bad_hub_url")]);
  }
  const { args } = parsed;
  return reportPrimary({
    deps,
    cwd,
    args,
    lane: {
      repo: facts.repo,
      workflow: facts.workflow,
      job: args.job,
      leg: args.leg,
      ref: args.ref,
      commitSha: sha,
      runAttempt: args.runAttempt,
      externalRunId: args.externalRunId,
    },
    hub: { url: facts.hubUrl, token: facts.token },
  });
};
