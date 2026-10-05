/**
 * What must be true before CI publishes a tag to npm (scripts/release-preflight.ts).
 *
 * Each check exists because an earlier release broke on exactly that point:
 * 0.8.0 and 0.9.0 were packed from a clone five merges stale, and a tag pushed
 * before the publish landed on the wrong commit and had to be re-cut. Publishing
 * from CI removes the laptop; these checks remove the rest.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  REQUIRED_CI_JOBS,
  checkCiGreen,
  checkVersions,
  isOnMainline,
  parseReleaseTag,
} from "../scripts/release-preflight.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const REPO = "NeverStopHH/crosscheck";

describe("the release tag", () => {
  test("names a plain semantic version with a v prefix", () => {
    expect(parseReleaseTag("v0.11.0")).toEqual({ ok: true, version: "0.11.0" });
  });

  test("refuses anything else, by name", () => {
    for (const tag of ["0.11.0", "v0.11", "v0.11.0-rc.1", "v0.11.0 ", "release-0.11.0", ""]) {
      const result = parseReleaseTag(tag);
      expect(result.ok).toBe(false);
    }
  });
});

describe("the package versions", () => {
  test("pass when every workspace package carries the tag's version", () => {
    const manifests = [
      { name: "@crosscheck/cli", version: "0.11.0" },
      { name: "@crosscheck/server", version: "0.11.0" },
    ];
    expect(checkVersions("0.11.0", manifests)).toEqual({ ok: true, detail: "2 packages at 0.11.0" });
  });

  test("fail and name every package that disagrees with the tag", () => {
    const manifests = [
      { name: "@crosscheck/cli", version: "0.11.0" },
      { name: "@crosscheck/server", version: "0.10.0" },
      { name: "@crosscheck/schema", version: "0.10.0" },
    ];
    const result = checkVersions("0.11.0", manifests);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("@crosscheck/server 0.10.0");
    expect(result.detail).toContain("@crosscheck/schema 0.10.0");
    expect(result.detail).not.toContain("@crosscheck/cli");
  });

  test("fail when no package was found at all", () => {
    expect(checkVersions("0.11.0", []).ok).toBe(false);
  });
});

describe("the tagged commit is on main", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  const git = async (cwd: string, ...args: string[]): Promise<string> => {
    const child = Bun.spawn({
      cmd: ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return out.trim();
  };

  const repoWithSideBranch = async (): Promise<{ dir: string; onMain: string; onSide: string }> => {
    const dir = await mkdtemp(join(tmpdir(), "cx-preflight-"));
    dirs.push(dir);
    await git(dir, "init", "-q", "-b", "main");
    await writeFile(join(dir, "a.txt"), "a\n");
    await git(dir, "add", "a.txt");
    await git(dir, "commit", "-q", "-m", "on main");
    const onMain = await git(dir, "rev-parse", "HEAD");
    await git(dir, "checkout", "-q", "-b", "side");
    await writeFile(join(dir, "b.txt"), "b\n");
    await git(dir, "add", "b.txt");
    await git(dir, "commit", "-q", "-m", "on side");
    const onSide = await git(dir, "rev-parse", "HEAD");
    return { dir, onMain, onSide };
  };

  test("passes for a commit main contains", async () => {
    const { dir, onMain } = await repoWithSideBranch();
    expect(await isOnMainline(dir, onMain, "main")).toBe(true);
  });

  test("fails for a commit only a side branch contains", async () => {
    const { dir, onSide } = await repoWithSideBranch();
    expect(await isOnMainline(dir, onSide, "main")).toBe(false);
  });
});

describe("CI on the tagged commit", () => {
  const run = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 11,
    name: "CI",
    head_branch: "main",
    status: "completed",
    conclusion: "success",
    ...overrides,
  });
  const job = (name: string, conclusion = "success", status = "completed"): Record<string, unknown> => ({
    name,
    status,
    conclusion,
  });
  const green = REQUIRED_CI_JOBS.map((name) => job(name));

  /** A fake of the two GitHub API reads, keyed by path. */
  const api =
    (runs: readonly unknown[], jobs: readonly unknown[]) =>
    async (path: string): Promise<unknown> => {
      if (path.includes("/actions/runs?")) {
        return { workflow_runs: runs };
      }
      if (path.endsWith("/jobs?per_page=100")) {
        return { jobs };
      }
      throw new Error(`unexpected path ${path}`);
    };

  test("passes when every required job of main's CI run on this commit succeeded", async () => {
    const result = await checkCiGreen(api([run()], green), REPO, SHA);
    expect(result.ok).toBe(true);
  });

  test("names the required job that failed", async () => {
    const jobs = [job(REQUIRED_CI_JOBS[0] ?? "", "failure"), ...green.slice(1)];
    const result = await checkCiGreen(api([run({ conclusion: "failure" })], jobs), REPO, SHA);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain(REQUIRED_CI_JOBS[0] ?? "missing");
  });

  test("refuses while a required job is still running, and says to re-run later", async () => {
    const jobs = [job(REQUIRED_CI_JOBS[0] ?? "", "", "in_progress"), ...green.slice(1)];
    const result = await checkCiGreen(api([run({ status: "in_progress", conclusion: null })], jobs), REPO, SHA);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("re-run");
  });

  test("refuses a commit that has no CI run on main", async () => {
    const result = await checkCiGreen(api([run({ head_branch: "feat/x" })], green), REPO, SHA);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("no CI run on main");
  });

  test("refuses when a required job is missing from the run", async () => {
    const result = await checkCiGreen(api([run()], green.slice(1)), REPO, SHA);
    expect(result.ok).toBe(false);
  });
});
