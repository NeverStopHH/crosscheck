/**
 * CCB-8 — THE REVALIDATION BUDGET, MEASURED RATHER THAN ASSERTED
 * (1.0 spec 02 §6, §7).
 *
 * §6 states the leg's cost as arithmetic ("at most
 * CLAIM_REVALIDATION_MAX_GIT_CALLS processes at STALENESS_GIT_TIMEOUT_MS
 * each") and then refuses to put a millisecond figure on it, because the
 * writer ran no benchmark. CCB-8 is the requirement that somebody does before
 * merge. This file is that somebody.
 *
 * THE HALF THAT CANNOT BE RED-FIRST, AND SAYS SO. The wall clock below is a
 * MEASUREMENT of a new cost, not a proof of new behaviour —
 * connector-claude/test/capture-latency.test.ts:11-21 states the rule this
 * file inherits: "A wall clock cannot be red-first ... These are MEASUREMENTS
 * of the new cost, not proofs of the new behaviour." Before this spec
 * `get_diagnosis` spent no revalidation git calls at all, so there is no
 * earlier tree in which a budget assertion about them could go red. It is
 * paired, deliberately, with a half that CAN: the PROCESS COUNT.
 *
 * THE HALF THAT CAN. `CLAIM_REVALIDATION_MAX_GIT_CALLS` is the bound that
 * makes the wall clock a property of the code rather than of the tree, and a
 * count is visible where a clock is not — a leg that spent one process per
 * CLAIM instead of one per GROUP is invisible on a two-claim fixture and
 * ruinous on a real one. So the count is taken from a `git` the leg actually
 * executed, by putting a counting shim first on PATH of a CHILD process
 * (executable lookup is fixed at process start —
 * fixtures/rungit-timeout-probe.ts says why the child is necessary), and it
 * fails when the bound is exceeded.
 *
 * Elapsed times are PRINTED, so a slow run is a number in the log rather than
 * a guess, and the assertions compare against the BUDGET rather than against
 * a remembered number: these move with machine load, and this machine is
 * shared.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CLAIM_REVALIDATION_MAX_GIT_CALLS,
  MCP_TIMEOUT_MS,
  STALENESS_GIT_TIMEOUT_MS,
} from "../src/constants.ts";
import { REVALIDATION_GROUPS_PER_PULL } from "../src/flows/claim-revalidation.ts";
import type { RevalidationGroup } from "../src/flows/claim-revalidation.ts";
import { git, makeRepo, writeRepoFile } from "./helpers.ts";

const SURFACE = "src/auth/verify.ts";
const DEFAULT_REF = "refs/remotes/origin/main";

/**
 * The named allowance: a tenth of the reader's MCP budget for the whole leg.
 *
 * A FRACTION OF THE BUDGET rather than a figure somebody measured once,
 * because the number this file prints is a property of the machine and the
 * number it asserts has to be a property of the design. `get_diagnosis`
 * already spends a hub round trip plus up to three bounded git calls on the
 * solved branch; a revalidation leg eating more than a tenth of the whole
 * budget would be competing with the answer the reader actually asked for.
 */
const LEG_ALLOWANCE_MS = MCP_TIMEOUT_MS / 10;

/**
 * The arithmetic ceiling the allowance must stay under to mean anything:
 * every git call this leg can spend, each taking its full deadline. An
 * allowance above this would be unfalsifiable, so it is asserted too.
 */
const WORST_CASE_MS =
  CLAIM_REVALIDATION_MAX_GIT_CALLS * STALENESS_GIT_TIMEOUT_MS;

const cleanups: string[] = [];

afterAll(async () => {
  await Promise.all(
    cleanups.map((path) => rm(path, { recursive: true, force: true })),
  );
});

/**
 * A `git` that counts and then BECOMES the real one.
 *
 * `exec` rather than a wrapper process, so the shim adds no measurable time
 * to the number this file prints: what is measured is the leg, not the
 * counting.
 */
const makeCountingGit = async (logPath: string): Promise<string> => {
  const binDir = await mkdtemp(join(tmpdir(), "cx-counting-git-"));
  cleanups.push(binDir);
  const real = Bun.which("git");
  if (real === null) {
    throw new Error("no git on PATH — this file measures real git calls");
  }
  const shim = join(binDir, "git");
  await writeFile(
    shim,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(logPath)}\nexec ${JSON.stringify(real)} "$@"\n`,
    "utf8",
  );
  await chmod(shim, 0o755);
  return binDir;
};

interface ProbeReport {
  readonly elapsedMs: number;
  readonly refCommit: string | null;
  readonly revalidated: number;
  readonly total: number;
  readonly results: readonly string[];
}

interface Measurement {
  readonly report: ProbeReport;
  readonly gitCalls: readonly string[];
}

const runProbe = async (
  root: string,
  groups: readonly RevalidationGroup[],
): Promise<Measurement> => {
  const logDir = await mkdtemp(join(tmpdir(), "cx-git-log-"));
  cleanups.push(logDir);
  const logPath = join(logDir, "calls.txt");
  const binDir = await makeCountingGit(logPath);
  // WARM THE SHIM, THEN FORGET IT. Measured on this machine: the FIRST call
  // through a freshly written `/bin/sh` wrapper costs 250 ms and the second
  // 16 ms, which is cold-start cost of the MEASURING APPARATUS — the shell,
  // the append and macOS's /usr/bin/git stub — sitting inside the product's
  // own 250 ms git deadline. Left unwarmed, this file would report the
  // harness and call it the leg. The warm-up's own call is then truncated
  // out of the log, so the count below is of the leg alone.
  Bun.spawnSync({ cmd: [join(binDir, "git"), "--version"], cwd: root });
  await writeFile(logPath, "", "utf8");
  const probe = join(
    import.meta.dir,
    "fixtures",
    "claim-drift-budget-probe.ts",
  );
  const proc = Bun.spawn({
    cmd: ["bun", probe, root, DEFAULT_REF, JSON.stringify(groups)],
    cwd: root,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  if (stdout.trim().length === 0) {
    throw new Error(`probe printed nothing: ${stderr}`);
  }
  const logged = await readFile(logPath, "utf8");
  return {
    report: JSON.parse(stdout.trim()) as ProbeReport,
    gitCalls: logged.split("\n").filter((line) => line.trim().length > 0),
  };
};

interface BusyRepo {
  readonly root: string;
  readonly groups: readonly RevalidationGroup[];
}

/**
 * A repo whose surface is rewritten once per landed commit, one group per
 * commit — the WORST shape for this leg, because every group's range is a
 * different `X..ref` and none of the work is shared between them.
 */
const makeBusyRepo = async (groupCount: number): Promise<BusyRepo> => {
  const root = await makeRepo("reval-budget", {
    remote: "git@github.com:acme/api.git",
  });
  cleanups.push(root);
  const observed: string[] = [];
  for (let index = 0; index <= groupCount; index += 1) {
    await writeRepoFile(root, SURFACE, `export const v = ${String(index)};\n`);
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-m", `rev ${String(index)}`]);
    const head = Bun.spawnSync({
      cmd: ["git", "rev-parse", "--short", "HEAD"],
      cwd: root,
    });
    observed.push(head.stdout.toString().trim());
  }
  await git(root, ["update-ref", DEFAULT_REF, "HEAD"]);
  return {
    root,
    // The newest commit is last in `observed` and is left out: every group
    // kept has commits after it, so each is a real `changed` reading rather
    // than a fast exit down the empty-range branch.
    groups: observed.slice(0, groupCount).map((commit, index) => ({
      observedAtCommit: commit,
      paths: [SURFACE],
      droppedPaths: 0,
      basis: "context_targets" as const,
      // THE FIRST GROUP CARRIES MANY CLAIMS, and that is the whole point of
      // the count. This fixture gave every group exactly one claim, so "one
      // process per CLAIM" and "one process per GROUP" were numerically
      // identical in it — and the regression this file's header names
      // ("a leg that spent one process per CLAIM instead of one per GROUP is
      // invisible on a two-claim fixture and ruinous on a real one") could
      // not make the assertion fail. Measured: moving `checkClaimDrift`
      // inside the per-claim loop left the test at 3 pass / 0 fail.
      //
      // One fat group is also the COMMON shape, not an exotic one: claims
      // written at one HEAD share an observation commit, so they land in one
      // group, and MAX_CLAIM_REVALIDATION_ENTRIES = 500 is sized for exactly
      // that.
      claimIds:
        index === 0
          ? Array.from(
              { length: CLAIMS_IN_THE_FAT_GROUP },
              (_unused, claimIndex) => `clm_${String(index)}_${String(claimIndex)}`,
            )
          : [`clm_${String(index)}`],
      newestAt: index,
    })),
  };
};

/**
 * How many claims the first group carries.
 *
 * Large enough that one-process-per-claim is unmistakable — it would cost
 * 2 x 40 processes in that group alone, far past any bound — and small enough
 * that the fixture stays a few seconds.
 */
const CLAIMS_IN_THE_FAT_GROUP = 40;

/**
 * The leg's OWN ceiling: one call to name the ref's commit, then at most two
 * per group. `CLAIM_REVALIDATION_MAX_GIT_CALLS` is the budget the design
 * publishes and it sits above this by construction, so asserting against it
 * alone is an assertion that cannot fail. Both are asserted: the tight one
 * catches the regression, the published one catches a design that outgrew its
 * own budget.
 */
const LEG_CEILING = 1 + 2 * REVALIDATION_GROUPS_PER_PULL;

/** Real git, real commits, a child process per case. */
const CASE_TIMEOUT_MS = 120_000;

describe("the revalidation leg costs what the design says it costs", () => {
  test(
    "a full pull's git calls stay inside the process bound",
    async () => {
      // Arrange: as many groups as one pull may measure, each a different
      // range, so nothing about this shape is shared or cached.
      const { root, groups } = await makeBusyRepo(REVALIDATION_GROUPS_PER_PULL);

      // Act
      const { report, gitCalls } = await runProbe(root, groups);

      // Assert: the count is the half a reviewer can act on. One process to
      // name the ref, then at most two per group — the hash leg, and only
      // where that came back empty the ls-tree separating "nothing touched
      // these paths" from "this ref never held them".
      process.stdout.write(
        `  revalidation leg: ${String(gitCalls.length)} git calls, ` +
          `${report.elapsedMs.toFixed(0)} ms for ` +
          `${String(report.revalidated)}/${String(report.total)} groups\n`,
      );
      // The TIGHT bound first: this is the one the regression moves. The
      // published budget is asserted after it, and can only fail if the
      // design itself outgrows what §6 promises.
      expect(gitCalls.length).toBeLessThanOrEqual(LEG_CEILING);
      expect(gitCalls.length).toBeLessThanOrEqual(
        CLAIM_REVALIDATION_MAX_GIT_CALLS,
      );
      expect(report.refCommit).not.toBeNull();
      // ONE RESULT PER CLAIM, not per group — which is the distinction this
      // fixture exists to make and could not make while every group held one
      // claim. The process count above stays at the group ceiling regardless.
      const claimCount = groups.reduce(
        (total, group) => total + group.claimIds.length,
        0,
      );
      expect(claimCount).toBeGreaterThan(groups.length);
      expect(report.results).toHaveLength(claimCount);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "a full pull fits the named allowance inside the MCP budget",
    async () => {
      // Arrange: the same worst shape. THIS ASSERTION IS A MEASUREMENT, not a
      // red-first proof — see the header.
      const { root, groups } = await makeBusyRepo(REVALIDATION_GROUPS_PER_PULL);

      // Act
      const { report } = await runProbe(root, groups);

      // Assert: the allowance has to be a real ceiling — below the arithmetic
      // worst case — before the elapsed assertion says anything at all.
      process.stdout.write(
        `  revalidation leg: ${report.elapsedMs.toFixed(0)} ms ` +
          `of a ${String(LEG_ALLOWANCE_MS)} ms allowance ` +
          `(worst case ${String(WORST_CASE_MS)} ms, ` +
          `MCP budget ${String(MCP_TIMEOUT_MS)} ms)\n`,
      );
      expect(LEG_ALLOWANCE_MS).toBeLessThan(WORST_CASE_MS);
      expect(report.elapsedMs).toBeLessThan(LEG_ALLOWANCE_MS);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "a tree with nothing to revalidate spends no group at all",
    async () => {
      // Arrange: the baseline the allowance is measured against. §6 claims
      // ZERO added cost where there is nothing to check, and the leg returns
      // before the ref resolution when the plan is empty — a pull of a tree
      // whose claims are all unbound must not pay for a question it cannot
      // ask (§8.5).
      const { root } = await makeBusyRepo(1);

      // Act
      const { report, gitCalls } = await runProbe(root, []);

      // Assert: not one process. This is what makes the allowance above a
      // measurement of the leg rather than of `get_diagnosis` in general.
      process.stdout.write(
        `  empty plan: ${String(gitCalls.length)} git calls, ` +
          `${report.elapsedMs.toFixed(0)} ms\n`,
      );
      expect(report.revalidated).toBe(0);
      expect(report.results).toHaveLength(0);
      expect(gitCalls).toHaveLength(0);
    },
    CASE_TIMEOUT_MS,
  );
});
