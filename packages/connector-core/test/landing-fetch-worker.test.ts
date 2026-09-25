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
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  fetchLandingBranches,
  parseLsRemote,
  runLandingFetchWorker,
} from "../src/landed-changes/fetch-worker.ts";
import { cloneKeyOf, readLandingFetchRecord } from "../src/landed-changes/fetch-state.ts";
import { makeHome } from "./helpers.ts";
import {
  MIKE,
  commitFile,
  gitIn,
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
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

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
    expect([...origin.existing.keys()]).toEqual(["staging"]);
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
