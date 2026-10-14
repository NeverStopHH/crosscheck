/**
 * Subprocess body for test/git-lane-sweep.test.ts: one sweepGitRoots call
 * under whatever `git` the launching test put first on PATH — a stalled one
 * (helpers.ts `makeStalledGitDir`, run by `runProbeWithGit`) — printing what
 * the sweep says it answered for. Its input is the call's own, as JSON, in the
 * first argument; the two instants JSON turned into strings are read back.
 *
 * Exits explicitly: the abandoned read of a stalled git must not hold this
 * process open past its answer.
 */
import { sweepGitRoots } from "../../src/flows/git-lane.ts";
import type { GitLaneRoot, SweepGitRootsInput } from "../../src/flows/git-lane.ts";

type WireRoot = Omit<GitLaneRoot, "since"> & { readonly since: string };
type WireInput = Omit<SweepGitRootsInput, "now" | "roots" | "allocate"> & {
  readonly now: string;
  readonly roots: readonly WireRoot[];
};

const wire = JSON.parse(process.argv[2] ?? "") as WireInput;
const sweep = await sweepGitRoots({
  ...wire,
  now: new Date(wire.now),
  roots: wire.roots.map((lane) => ({ ...lane, since: new Date(lane.since) })),
});
console.log(JSON.stringify({ unavailable: sweep.unavailable, swept: sweep.swept }));
process.exit(0);
