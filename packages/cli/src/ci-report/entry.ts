/**
 * THE CI REPORTER'S ONE ENTRY, shared by `crosscheck ci-report` (the published
 * command other repositories' CI runs) and packages/cli/scripts/ci-report.ts
 * (this repository's own CI, which runs from source). Both hand it argv, the
 * environment and the working directory; it prints and returns the exit code.
 * One function, so the two cannot drift — test/ci-report-entry.test.ts spawns
 * both and compares what a CI log would show.
 *
 * NEVER A RED JOB FOR THE REPORTER'S OWN SAKE. An unexpected throw — the one
 * thing run.ts does not already turn into a sentence — is printed and returns
 * EXIT_OK: a side channel that blocked merges when IT broke would be the
 * "block, never inform" this project refuses (spec 05 §8.3). The hub then
 * reads `unknown` at this commit, which `crosscheck doctor` says out loud.
 * A usage error stays EXIT_USAGE: that is the workflow author's mistake, the
 * same on every run, and must surface the first time.
 */
import { EXIT_OK } from "@crosscheck/connector-core/constants.ts";

import type { CliResult } from "../cli/login.ts";
import { runCiReport } from "./run.ts";

type Env = Readonly<Record<string, string | undefined>>;
type CiReportRun = (argv: readonly string[], env: Env, cwd: string) => Promise<CliResult>;

/** What the reporter prints and exits with. Never throws; `run` is the seam tests replace. */
export const ciReportOutcome = async (
  argv: readonly string[],
  env: Env,
  cwd: string,
  run: CiReportRun = runCiReport,
): Promise<CliResult> => {
  try {
    return await run(argv, env, cwd);
  } catch (error) {
    return {
      stdout: `ci-report: internal failure (${error instanceof Error ? error.message : String(error)}) — this run is not recorded; coverage.ci stays unknown at this commit\n`,
      exitCode: EXIT_OK,
    };
  }
};

export const ciReportMain = async (argv: readonly string[], env: Env, cwd: string): Promise<number> => {
  const outcome = await ciReportOutcome(argv, env, cwd);
  process.stdout.write(outcome.stdout);
  return outcome.exitCode;
};
