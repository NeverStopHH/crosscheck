#!/usr/bin/env bun
/**
 * THE CI REPORTER'S ENTRY (spec 05 §3.7, §10 D4): run by the `test` job of
 * .github/workflows/ci.yml after `bun test --reporter=junit`, on every
 * matrix leg, with `if: always()`:
 *
 *   bun run packages/cli/scripts/ci-report.ts --junit junit.xml --job test
 *     --leg ${{ matrix.os }} --ref ${{ github.head_ref || github.ref_name }}
 *     --attempt ${{ github.run_attempt }} --run-id ${{ github.run_id }}
 *     --sha ${{ github.event.pull_request.head.sha || github.sha }}
 *
 * with CROSSCHECK_HUB_URL and CROSSCHECK_CI_TOKEN from repository secrets.
 * This repository runs the reporter from source; every other repository runs
 * the same code as `bunx crosscheck-hub ci-report …` from the published
 * package. Both go through src/ci-report/entry.ts, which also holds the
 * never-a-red-job rule; this file only hands it argv, the environment and the
 * working directory, and exits with what it returns.
 *
 * Not a developer's command either way: no config, no api key, no spool, no
 * `~/.crosscheck`. The runner it executes on belongs to nobody on the team.
 *
 * One reporter exists, for one provider — and the two counts are held equal
 * here rather than in prose that could drift (05 §7):
 *
 * VERIFY: bun -e 'const {CI_PROVIDERS}=await import("./packages/schema/src/ci-run.ts");console.log(CI_PROVIDERS.length, (await Array.fromAsync(new Bun.Glob("packages/cli/scripts/ci-report*.ts").scan())).length)'
 * PRINTS: 1 1
 */
import { ciReportMain } from "../src/ci-report/entry.ts";

process.exit(await ciReportMain(process.argv.slice(2), process.env, process.cwd()));
