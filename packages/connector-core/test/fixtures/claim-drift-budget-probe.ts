/**
 * Subprocess body for test/claim-revalidation-budget.test.ts: spends ONE
 * pull's worth of the revalidation leg — the ref resolution plus every
 * planned group — against whatever `git` the launching test put first on
 * PATH, and prints the elapsed time as JSON.
 *
 * RUNS AS A CHILD PROCESS for the reason fixtures/rungit-timeout-probe.ts
 * gives: executable lookup is fixed at process start, so a counting `git`
 * shim only takes effect in a process launched with it already on PATH.
 * Mutating process.env.PATH inside the test would leave Bun.spawn resolving
 * the real binary and the count would be of nothing.
 *
 * The plan arrives as JSON on argv rather than being rebuilt here, so the
 * parent decides how many groups a pull is asked for and this file measures
 * exactly what it was handed.
 */
import { readClaimDrift } from "../../src/flows/claim-revalidation.ts";
import type { RevalidationGroup } from "../../src/flows/claim-revalidation.ts";
import { resolveRefCommit } from "../../src/git/claim-drift.ts";

const [root, ref, groupsJson] = process.argv.slice(2);
if (root === undefined || ref === undefined || groupsJson === undefined) {
  throw new Error("usage: claim-drift-budget-probe <root> <ref> <groups-json>");
}
const groups = JSON.parse(groupsJson) as readonly RevalidationGroup[];

/**
 * The leg's own order, mirrored exactly: a pull with nothing to revalidate
 * returns BEFORE the ref resolution (mcp/tools/get-diagnosis.ts
 * revalidateClaims, `plan.total === 0`). Resolving first would spend a
 * process on every pull of every tree whose claims are all unbound — the
 * cost §6 claims is zero — and a probe that resolved anyway would measure a
 * leg this product does not have.
 */
const started = performance.now();
const refCommit = groups.length === 0 ? null : await resolveRefCommit(root, ref);
const readings =
  refCommit === null
    ? { entries: [], revalidated: 0, total: groups.length }
    : await readClaimDrift(root, refCommit, { groups, total: groups.length });
const elapsedMs = performance.now() - started;
console.log(
  JSON.stringify({
    elapsedMs,
    refCommit,
    revalidated: readings.revalidated,
    total: readings.total,
    results: readings.entries.map((entry) => entry.result),
  }),
);
process.exit(0);
