#!/usr/bin/env bun
/**
 * THE CI REPORTER'S ENTRY (spec 05 §3.7, §10 D4): run by the `test` job of
 * .github/workflows/ci.yml after `bun test --reporter=junit`, on every
 * matrix leg, with `if: always()`:
 *
 *   bun run packages/cli/scripts/ci-report.ts --junit junit.xml --job test
 *     --leg ${{ matrix.os }} --ref ${{ github.ref_name }}
 *     --attempt ${{ github.run_attempt }} --run-id ${{ github.run_id }}
 *     --sha ${{ github.event.pull_request.head.sha || github.sha }}
 *
 * with CROSSCHECK_HUB_URL and CROSSCHECK_CI_TOKEN from repository secrets.
 * Everything it does is in src/ci-report/run.ts; this file only hands it argv,
 * the environment and the working directory, prints, and exits.
 *
 * A SCRIPT, NOT A `crosscheck` SUBCOMMAND, because it is not a developer's
 * command: no config, no api key, no spool, no `~/.crosscheck`. The runner it
 * executes on belongs to nobody on the team.
 *
 * NEVER A RED JOB FOR THE REPORTER'S OWN SAKE. An unexpected throw — the one
 * thing run.ts does not already turn into a sentence — is printed and exits
 * 0: a side channel that blocked merges when IT broke would be the "block,
 * never inform" this project refuses (§8.3). The hub then reads `unknown` at
 * this commit, which `crosscheck doctor` says out loud.
 *
 * One reporter exists, for one provider — and the two counts are held equal
 * here rather than in prose that could drift (05 §7):
 *
 * VERIFY: bun -e 'const {CI_PROVIDERS}=await import("./packages/schema/src/ci-run.ts");console.log(CI_PROVIDERS.length, (await Array.fromAsync(new Bun.Glob("packages/cli/scripts/ci-report*.ts").scan())).length)'
 * PRINTS: 1 1
 */
import { EXIT_OK } from "@crosscheck/connector-core/constants.ts";

import { runCiReport } from "../src/ci-report/run.ts";

const main = async (): Promise<number> => {
  const result = await runCiReport(
    process.argv.slice(2),
    process.env,
    process.cwd(),
  );
  process.stdout.write(result.stdout);
  return result.exitCode;
};

process.exit(
  await main().catch((error: unknown) => {
    process.stdout.write(
      `ci-report: internal failure (${error instanceof Error ? error.message : String(error)}) — this run is not recorded; coverage.ci stays unknown at this commit\n`,
    );
    return EXIT_OK;
  }),
);
