/**
 * THE BACKGROUND FETCH OF THE LANDING BRANCHES, against real git
 * (docs/1.0/landed-changes.md, step 2).
 *
 * The failure it closes: git only knows what the clone has fetched. Mike
 * merged into staging an hour ago, Nick has not run `git fetch` since the
 * morning, and the pre-edit stop — which asks Nick's own clone — cannot see
 * the change it exists to warn about.
 *
 * What these tests pin is the promise that makes a fetch nobody asked for
 * acceptable at all: it moves `refs/remotes/origin/<landing branch>` and
 * NOTHING ELSE — no local branch, no working tree, no tag, no FETCH_HEAD
 * (which a `git pull` reads between its own fetch and merge), no pruning, no
 * branch that is not a landing branch.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  fetchLandingBranches,
  isGitRecentEnough,
  parseLsRemote,
  runLandingFetchWorker,
} from "../src/landed-changes/fetch-worker.ts";
import { cloneKeyOf, readLandingFetchRecord } from "../src/landed-changes/fetch-state.ts";
import { makeHome } from "./helpers.ts";
import {
  MIKE,
  commitFile,
  gitIn,
  isolatedGitEnv,
  landWithSquash,
  makeLandingRepos,
} from "./fixtures/landing-repos.ts";
import type { LandingRepos } from "./fixtures/landing-repos.ts";

/** Real clones, a bare origin and several pushes per test. */
const HEAVY_SETUP_MS = 60_000;

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

/** The developer's own git settings can neither break nor rescue a test. */
/** The developer's own ssh, askpass and Crosscheck settings are shut out. */
const ENV = isolatedGitEnv();

const repos = async (
  label: string,
  landingBranches: readonly string[] = ["staging"],
): Promise<LandingRepos> => {
  const made = await makeLandingRepos(label, landingBranches);
  paths.push(made.base);
  return made;
};

const tipOf = async (clone: string, ref: string): Promise<string | null> =>
  gitIn(clone, ["rev-parse", "--verify", "--quiet", ref]).catch(() => null);

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

const writeRepoConfig = (clone: string, config: unknown): Promise<void> =>
  writeFile(join(clone, ".crosscheck.json"), JSON.stringify(config), "utf8");

const mikeSquashesOnto = (made: LandingRepos, landing: string, content: string) =>
  landWithSquash(made, {
    file: "src/lines.ts",
    content,
    subject: `Change on ${landing}`,
    landing,
    landedAt: "2026-09-24T10:00:00Z",
  });

describe("fetching the landing branches", () => {
  test(
    "brings the reader a landing branch the teammate moved since the reader's last fetch",
    async () => {
      const made = await repos("lf-moves");
      const landed = await mikeSquashesOnto(made, "staging", "export const offset = 2;\n");
      expect(await tipOf(made.reader, "refs/remotes/origin/staging")).not.toBe(landed);

      const outcome = await fetchLandingBranches({ root: made.reader, env: ENV });

      expect(outcome).toEqual({ kind: "fetched", branches: ["main", "staging"] });
      expect(await tipOf(made.reader, "refs/remotes/origin/staging")).toBe(landed);
    },
    HEAVY_SETUP_MS,
  );

  test(
    "moves the landing branches' remote-tracking refs and nothing else",
    async () => {
      const made = await repos("lf-nothing-else");
      // The reader's own state: a local main, the feature branch checked out,
      // and an uncommitted edit.
      await writeFile(join(made.reader, "README.md"), "# my unsaved edit\n", "utf8");
      const localBefore = await gitIn(made.reader, [
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        "refs/heads",
      ]);
      const statusBefore = await gitIn(made.reader, ["status", "--porcelain"]);
      // Mike moves main and staging, and ALSO pushes a tag and a feature
      // branch — neither of which is a landing branch.
      const onMain = await mikeSquashesOnto(made, "main", "export const offset = 3;\n");
      const onStaging = await mikeSquashesOnto(made, "staging", "export const offset = 4;\n");
      await gitIn(made.teammate, ["tag", "v1.0.0"]);
      await gitIn(made.teammate, ["push", "-q", "origin", "v1.0.0"]);
      await gitIn(made.teammate, ["checkout", "-q", "-b", "feature/secret-work"]);
      await commitFile(made.teammate, "src/other.ts", "export {};\n", "wip", { as: MIKE });
      await gitIn(made.teammate, ["push", "-q", "origin", "feature/secret-work"]);
      const fetchHead = join(made.reader, ".git", "FETCH_HEAD");
      await rm(fetchHead, { force: true });

      const outcome = await fetchLandingBranches({ root: made.reader, env: ENV });

      expect(outcome.kind).toBe("fetched");
      expect(await tipOf(made.reader, "refs/remotes/origin/main")).toBe(onMain);
      expect(await tipOf(made.reader, "refs/remotes/origin/staging")).toBe(onStaging);
      expect(
        await gitIn(made.reader, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"]),
      ).toBe(localBefore);
      expect(await gitIn(made.reader, ["status", "--porcelain"])).toBe(statusBefore);
      expect(await gitIn(made.reader, ["for-each-ref", "refs/tags"])).toBe("");
      expect(await tipOf(made.reader, "refs/remotes/origin/feature/secret-work")).toBeNull();
      // A `git pull` of the reader's reads FETCH_HEAD between its own fetch
      // and its merge; a background fetch that wrote it could make that pull
      // merge the wrong thing.
      expect(await exists(fetchHead)).toBe(false);
    },
    HEAVY_SETUP_MS,
  );

  test(
    "a named landing branch origin does not have costs that branch only",
    async () => {
      const made = await repos("lf-missing-branch");
      await writeRepoConfig(made.reader, { landingBranches: ["staging", "release"] });
      const landed = await mikeSquashesOnto(made, "staging", "export const offset = 5;\n");

      const outcome = await fetchLandingBranches({ root: made.reader, env: ENV });

      // Asking git to fetch a branch origin lacks fails the WHOLE fetch, so
      // origin is asked first and the missing name is left out.
      expect(outcome).toEqual({ kind: "fetched", branches: ["staging"] });
      expect(await tipOf(made.reader, "refs/remotes/origin/staging")).toBe(landed);
    },
    HEAVY_SETUP_MS,
  );

  test(
    "never prunes, whatever the reader's fetch.prune says",
    async () => {
      const made = await repos("lf-no-prune", ["staging", "develop"]);
      await gitIn(made.reader, ["config", "fetch.prune", "true"]);
      const develop = await tipOf(made.reader, "refs/remotes/origin/develop");
      expect(develop).not.toBeNull();
      await gitIn(made.teammate, ["push", "-q", "origin", "--delete", "develop"]);

      const outcome = await fetchLandingBranches({ root: made.reader, env: ENV });

      expect(outcome).toEqual({ kind: "fetched", branches: ["main", "staging"] });
      expect(await tipOf(made.reader, "refs/remotes/origin/develop")).toBe(develop);
    },
    HEAVY_SETUP_MS,
  );

  test(
    "a single-branch clone gains the landing branches it never had",
    async () => {
      const made = await repos("lf-single-branch");
      const single = join(made.base, "single");
      await gitIn(made.base, ["clone", "-q", "--single-branch", "--branch", "main", made.origin, single]);
      expect(await tipOf(single, "refs/remotes/origin/staging")).toBeNull();

      const outcome = await fetchLandingBranches({ root: single, env: ENV });

      expect(outcome).toEqual({ kind: "fetched", branches: ["main", "staging"] });
      expect(await tipOf(single, "refs/remotes/origin/staging")).toBe(
        await tipOf(made.teammate, "refs/remotes/origin/staging"),
      );
    },
    HEAVY_SETUP_MS,
  );

  test(
    "the default branch is the one origin names, not a guess",
    async () => {
      const made = await repos("lf-trunk");
      await gitIn(made.teammate, ["push", "-q", "origin", "main:trunk"]);
      await gitIn(made.origin, ["symbolic-ref", "HEAD", "refs/heads/trunk"]);
      await gitIn(made.teammate, ["push", "-q", "origin", "--delete", "main"]);

      const outcome = await fetchLandingBranches({ root: made.reader, env: ENV });

      expect(outcome).toEqual({ kind: "fetched", branches: ["trunk", "staging"] });
      expect(await tipOf(made.reader, "refs/remotes/origin/trunk")).not.toBeNull();
    },
    HEAVY_SETUP_MS,
  );
});

describe("what the developer's own setup cannot widen or break", () => {
  test(
    "a configured fetch refspec that names a local branch is not applied",
    async () => {
      // Without --refmap= git applies every remote.origin.fetch refspec to
      // what is fetched ("opportunistic updates") — including into refs/heads.
      const made = await repos("lf-refmap");
      await gitIn(made.reader, ["config", "--add", "remote.origin.fetch", "+refs/heads/staging:refs/heads/staging-mirror"]);
      const landed = await mikeSquashesOnto(made, "staging", "export const offset = 8;\n");

      const outcome = await fetchLandingBranches({ root: made.reader, env: ENV });

      expect(outcome.kind).toBe("fetched");
      expect(await tipOf(made.reader, "refs/remotes/origin/staging")).toBe(landed);
      expect(await tipOf(made.reader, "refs/heads/staging-mirror")).toBeNull();
    },
    HEAVY_SETUP_MS,
  );

  test(
    "the branch the stop reads stays fresh after origin's default branch moved",
    async () => {
      // The clone's origin/HEAD still names main (git never updates an
      // existing one); origin's HEAD now names staging. The stop reads main.
      const made = await repos("lf-head-moved");
      await gitIn(made.origin, ["symbolic-ref", "HEAD", "refs/heads/staging"]);
      const onMain = await mikeSquashesOnto(made, "main", "export const offset = 9;\n");

      const outcome = await fetchLandingBranches({ root: made.reader, env: ENV });

      expect(outcome.kind === "fetched" ? [...outcome.branches].sort() : outcome).toEqual(["main", "staging"]);
      expect(await tipOf(made.reader, "refs/remotes/origin/main")).toBe(onMain);
    },
    HEAVY_SETUP_MS,
  );

  test(
    "a default branch with a name of its own stays fresh after origin's HEAD moved away from it",
    async () => {
      // The clone was made while origin's default was trunk — a name the rule
      // does not ask about by itself — and origin's HEAD has since moved.
      const made = await repos("lf-trunk-moved");
      await gitIn(made.teammate, ["push", "-q", "origin", "main:trunk"]);
      await gitIn(made.origin, ["symbolic-ref", "HEAD", "refs/heads/trunk"]);
      const fresh = join(made.base, "fresh");
      await gitIn(made.base, ["clone", "-q", made.origin, fresh]);
      await gitIn(made.origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);
      const onTrunk = await mikeSquashesOnto(made, "trunk", "export const offset = 12;\n");

      const outcome = await fetchLandingBranches({ root: fresh, env: ENV });

      expect(outcome.kind === "fetched" ? outcome.branches : outcome).toContain("trunk");
      expect(await tipOf(fresh, "refs/remotes/origin/trunk")).toBe(onTrunk);
    },
    HEAVY_SETUP_MS,
  );

  test(
    "a connection that drops after origin answered is a failure, not a success of what was already current",
    async () => {
      // origin answers ls-remote, then refuses the fetch itself: main was
      // already current, staging is behind — and NOTHING was brought.
      const made = await repos("lf-dropped");
      await mikeSquashesOnto(made, "staging", "export const offset = 13;\n");
      const count = join(made.base, "upload-pack.count");
      const wrapper = join(made.base, "flaky-upload-pack");
      await writeFile(
        wrapper,
        `#!/bin/sh\necho x >> '${count}'\nif [ "$(wc -l < '${count}')" -gt 1 ]; then exit 1; fi\nexec git upload-pack "$@"\n`,
        "utf8",
      );
      await chmod(wrapper, 0o755);
      await gitIn(made.reader, ["config", "remote.origin.uploadpack", wrapper]);

      const outcome = await fetchLandingBranches({ root: made.reader, env: ENV });

      expect(outcome).toEqual({ kind: "failed", step: "fetch", timedOut: false });
    },
    HEAVY_SETUP_MS,
  );

  test(
    "at the deadline nothing the call started outlives it",
    async () => {
      // A fake ssh whose own child ignores SIGTERM: the shape of a
      // ProxyCommand, or a helper stuck on a dialog.
      const made = await repos("lf-deadline-tree");
      await gitIn(made.reader, ["remote", "set-url", "origin", "ssh://git@example.invalid/acme/api.git"]);
      const pidFile = join(made.base, "stubborn.pid");
      const stubbornSsh = join(made.base, "stubborn-ssh");
      await writeFile(
        stubbornSsh,
        `#!/bin/sh\ntrap "" TERM\n/bin/sh -c 'trap "" TERM; echo $$ > "${pidFile}.tmp" && mv "${pidFile}.tmp" "${pidFile}"; exec /bin/sleep 30' &\nwait\n`,
        "utf8",
      );
      await chmod(stubbornSsh, 0o755);

      const outcome = await fetchLandingBranches({
        root: made.reader,
        env: { ...ENV, GIT_SSH_COMMAND: stubbornSsh },
        timeouts: { lsRemoteMs: 1500 },
      });

      expect(outcome).toEqual({ kind: "failed", step: "ls-remote", timedOut: true });
      const stubborn = Number((await Bun.file(pidFile).text()).trim());
      let alive = true;
      for (let waited = 0; waited < 2000 && alive; waited += 50) {
        try {
          process.kill(stubborn, 0);
          await Bun.sleep(50);
        } catch {
          alive = false;
        }
      }
      expect(alive).toBe(false);
    },
    HEAVY_SETUP_MS,
  );

  test(
    "origin's HEAD naming a branch called HEAD cannot write through the symref",
    async () => {
      const made = await repos("lf-head-branch");
      const mainBefore = await tipOf(made.reader, "refs/remotes/origin/main");
      const foreign = await gitIn(made.teammate, ["commit-tree", "-m", "foreign", "4b825dc642cb6eb9a060e54bf8d69288fbee4904"]);
      await gitIn(made.teammate, ["push", "-q", "origin", `${foreign}:refs/heads/HEAD`]);
      await gitIn(made.origin, ["symbolic-ref", "HEAD", "refs/heads/HEAD"]);

      await fetchLandingBranches({ root: made.reader, env: ENV });

      expect(await tipOf(made.reader, "refs/remotes/origin/main")).toBe(mainBefore);
    },
    HEAVY_SETUP_MS,
  );

  test(
    "one branch git refuses costs that branch, and the others' fetch still counts",
    async () => {
      // A stale origin/release (a file) is in the way of origin/release/2026
      // (a directory): git refuses that ref and fails its whole answer, while
      // main is updated all the same.
      const made = await repos("lf-partial");
      await gitIn(made.reader, ["update-ref", "refs/remotes/origin/release", "HEAD"]);
      await gitIn(made.teammate, ["push", "-q", "origin", "main:release/2026"]);
      await writeRepoConfig(made.reader, { landingBranches: ["main", "release/2026"] });
      const onMain = await mikeSquashesOnto(made, "main", "export const offset = 10;\n");

      const outcome = await fetchLandingBranches({ root: made.reader, env: ENV });

      expect(outcome).toEqual({ kind: "fetched", branches: ["main"], missed: ["release/2026"] });
      expect(await tipOf(made.reader, "refs/remotes/origin/main")).toBe(onMain);
    },
    HEAVY_SETUP_MS,
  );

  test(
    "an origin that does not answer in time is a failure named as a deadline",
    async () => {
      const made = await repos("lf-deadline");
      await gitIn(made.reader, ["remote", "set-url", "origin", "ssh://git@example.invalid/acme/api.git"]);
      const slowSsh = join(made.base, "slow-ssh");
      await writeFile(slowSsh, "#!/bin/sh\nsleep 10\n", "utf8");
      await chmod(slowSsh, 0o755);

      const outcome = await fetchLandingBranches({
        root: made.reader,
        env: { ...ENV, GIT_SSH_COMMAND: slowSsh },
        timeouts: { lsRemoteMs: 300 },
      });

      expect(outcome).toEqual({ kind: "failed", step: "ls-remote", timedOut: true });
    },
    HEAVY_SETUP_MS,
  );

  test(
    "git runs with the environment the worker was handed, not this process's",
    async () => {
      // The worker process's own env IS the handed one in production; in
      // this test runner it is not, and a variable only the runner has must
      // not reach git. GIT_TRACE is one git acts on visibly: it writes a file.
      const made = await repos("lf-handed-env");
      await mikeSquashesOnto(made, "staging", "export const offset = 14;\n");
      const trace = join(made.base, "git-trace.log");
      process.env["GIT_TRACE"] = trace;
      try {
        const { GIT_TRACE: _dropped, ...handed } = ENV;

        const outcome = await fetchLandingBranches({ root: made.reader, env: handed });

        expect(outcome.kind).toBe("fetched");
        expect(await exists(trace)).toBe(false);
      } finally {
        delete process.env["GIT_TRACE"];
      }
    },
    HEAVY_SETUP_MS,
  );

  test(
    "no commit-graph file is written on the developer's behalf",
    async () => {
      const made = await repos("lf-commit-graph");
      await gitIn(made.reader, ["config", "fetch.writeCommitGraph", "true"]);
      await mikeSquashesOnto(made, "staging", "export const offset = 11;\n");

      await fetchLandingBranches({ root: made.reader, env: ENV });

      expect(await exists(join(made.reader, ".git", "objects", "info", "commit-graphs"))).toBe(false);
      expect(await exists(join(made.reader, ".git", "objects", "info", "commit-graph"))).toBe(false);
    },
    HEAVY_SETUP_MS,
  );

  test("a git older than 2.29 is recognised; newer and unknown wordings are not refused", () => {
    expect(isGitRecentEnough("git version 2.28.1")).toBe(false);
    expect(isGitRecentEnough("git version 1.9.5")).toBe(false);
    expect(isGitRecentEnough("git version 2.29.0")).toBe(true);
    expect(isGitRecentEnough("git version 2.50.1 (Apple Git-155)")).toBe(true);
    expect(isGitRecentEnough("git version 3.0.0")).toBe(true);
    expect(isGitRecentEnough("something else entirely")).toBe(true);
  });
});

describe("when there is nothing to fetch, or it cannot be fetched", () => {
  test("a clone without origin is skipped, not failed", async () => {
    const lone = await mkdtemp(join(tmpdir(), "cx-lf-no-origin-"));
    paths.push(lone);
    await gitIn(lone, ["init", "-q", "--initial-branch=main"]);

    expect(await fetchLandingBranches({ root: lone, env: ENV })).toEqual({
      kind: "skipped",
      why: "no-origin",
    });
  });

  test(
    "a shallow clone is skipped: the stop is silent there anyway",
    async () => {
      const made = await repos("lf-shallow");
      const shallow = join(made.base, "shallow");
      await gitIn(made.base, ["clone", "-q", "--depth", "1", `file://${made.origin}`, shallow]);

      expect(await fetchLandingBranches({ root: shallow, env: ENV })).toEqual({
        kind: "skipped",
        why: "shallow",
      });
    },
    HEAVY_SETUP_MS,
  );

  test(
    "an origin that cannot be reached is a failure, named by its step",
    async () => {
      const made = await repos("lf-unreachable");
      await gitIn(made.reader, ["remote", "set-url", "origin", join(made.base, "gone.git")]);

      expect(await fetchLandingBranches({ root: made.reader, env: ENV })).toEqual({
        kind: "failed",
        step: "ls-remote",
        timedOut: false,
      });
    },
    HEAVY_SETUP_MS,
  );

  test(
    "switched off by the team, by one person, or by an empty landing list: nothing moves",
    async () => {
      const made = await repos("lf-switched-off");
      const before = await tipOf(made.reader, "refs/remotes/origin/staging");
      await mikeSquashesOnto(made, "staging", "export const offset = 6;\n");

      await writeRepoConfig(made.reader, { landingFetch: false });
      expect(await fetchLandingBranches({ root: made.reader, env: ENV })).toEqual({
        kind: "skipped",
        why: "off",
      });
      await writeRepoConfig(made.reader, { landingBranches: [] });
      expect(await fetchLandingBranches({ root: made.reader, env: ENV })).toEqual({
        kind: "skipped",
        why: "off",
      });
      await writeRepoConfig(made.reader, {});
      expect(
        await fetchLandingBranches({
          root: made.reader,
          env: { ...ENV, CROSSCHECK_LANDING_FETCH: "off" },
        }),
      ).toEqual({ kind: "skipped", why: "off" });

      expect(await tipOf(made.reader, "refs/remotes/origin/staging")).toBe(before);
    },
    HEAVY_SETUP_MS,
  );
});

describe("reading origin's answer", () => {
  const SHA = "a".repeat(40);

  test("origin's HEAD names the default branch when it resolves", () => {
    const origin = parseLsRemote(
      `ref: refs/heads/trunk\tHEAD\n${SHA}\tHEAD\n${SHA}\trefs/heads/staging\n`,
    );

    expect(origin.headBranch).toBe("trunk");
    expect(new Map(origin.existing)).toEqual(new Map([["staging", SHA], ["trunk", SHA]]));
  });

  test("the default branch's tip comes from the HEAD line when its name was not asked about", () => {
    const origin = parseLsRemote(`ref: refs/heads/trunk\tHEAD\n${SHA}\tHEAD\n`);

    expect(origin.existing.get("trunk")).toBe(SHA);
  });

  test("an unborn HEAD — an empty origin — names nothing to fetch", () => {
    // `ls-remote --symref` on an empty repository prints the symref and no
    // commit for it; fetching that branch would fail the whole fetch.
    expect(parseLsRemote("ref: refs/heads/main\tHEAD\n").headBranch).toBeNull();
  });

  test("a HEAD that names something git cannot take as a branch is ignored", () => {
    expect(parseLsRemote(`ref: refs/heads/-rf\tHEAD\n${SHA}\tHEAD\n`).headBranch).toBeNull();
  });
});

describe("the worker process's own entry", () => {
  test(
    "records what it did, for the clone, in Crosscheck's home and never in the repo",
    async () => {
      const made = await repos("lf-entry");
      const home = await makeHome("lf-entry");
      paths.push(home);
      const landed = await mikeSquashesOnto(made, "staging", "export const offset = 7;\n");
      const before = await gitIn(made.reader, ["status", "--porcelain", "--ignored"]);

      const code = await runLandingFetchWorker(["--root", made.reader], {
        ...ENV,
        CROSSCHECK_HOME: home,
      });

      expect(code).toBe(0);
      expect(await tipOf(made.reader, "refs/remotes/origin/staging")).toBe(landed);
      const key = await cloneKeyOf(made.reader);
      expect(key).not.toBeNull();
      const record = await readLandingFetchRecord(home, key ?? "");
      expect(record.last?.outcome).toEqual({ kind: "fetched", branches: ["main", "staging"] });
      expect(record.lastSuccessAt).not.toBeNull();
      expect(record.failuresInARow).toBe(0);
      expect(await gitIn(made.reader, ["status", "--porcelain", "--ignored"])).toBe(before);
    },
    HEAVY_SETUP_MS,
  );

  test("refuses to run without a --root", async () => {
    const home = await makeHome("lf-entry-no-root");
    paths.push(home);
    await mkdir(join(home, "state"), { recursive: true });

    expect(await runLandingFetchWorker([], { ...ENV, CROSSCHECK_HOME: home })).not.toBe(0);
  });
});
