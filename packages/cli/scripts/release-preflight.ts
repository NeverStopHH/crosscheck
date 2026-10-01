/**
 * RELEASE PREFLIGHT — what must be true before CI publishes a tag to npm.
 *
 * `.github/workflows/publish.yml` runs this before `npm publish`. It prints
 * one line per check, and any failure exits 1, so nothing reaches the
 * registry. Each check makes one earlier release failure impossible:
 *
 *   1. The tag is `vMAJOR.MINOR.PATCH` — it names the version that ships.
 *   2. Every workspace package carries that version. The pack script refuses
 *      packages that disagree with EACH OTHER; this ties them to the tag, so a
 *      `v0.11.0` tag on a tree still at 0.10.0 cannot publish 0.10.0 again.
 *   3. The tagged commit is on main. 0.8.0 and 0.9.0 were packed from a clone
 *      five merges behind main; a tag on a side branch or a stale commit now
 *      publishes nothing.
 *   4. CI on this very commit is green: the Test & Typecheck legs of the CI
 *      run for its push to main succeeded. Those legs carry the whole suite and
 *      the packed-tarball test. The mutation proof is not waited for: it
 *      guards the tests rather than the artifact, and a 90-minute wait is the
 *      kind of friction that sends people back to publishing by hand.
 *
 * Usage (CI only): bun packages/cli/scripts/release-preflight.ts
 * Reads GITHUB_REF_NAME (the tag), GITHUB_SHA, GITHUB_REPOSITORY and GH_TOKEN.
 */
import { Glob } from "bun";
import { join } from "node:path";
import { z } from "zod";

/** The CI jobs that must have succeeded on the tagged commit (ci.yml's `test` matrix). */
export const REQUIRED_CI_JOBS = [
  "Test & Typecheck (ubuntu-latest)",
  "Test & Typecheck (macos-latest)",
] as const;

/** The `name:` of .github/workflows/ci.yml. */
const CI_WORKFLOW_NAME = "CI";
const MAINLINE_BRANCH = "main";
/** What `actions/checkout` with `fetch-depth: 0` leaves for the main branch. */
const MAINLINE_REF = "origin/main";
const TAG_PATTERN = /^v(\d+\.\d+\.\d+)$/;
const GITHUB_API = "https://api.github.com";
/** Per request; the API answers in well under a second, this only bounds a hang. */
const GITHUB_API_TIMEOUT_MS = 15_000;
const SHORT_SHA_LENGTH = 7;
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

export type TagResult =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly detail: string };

export interface CheckResult {
  readonly ok: boolean;
  readonly detail: string;
}

export interface Manifest {
  readonly name: string;
  readonly version: string;
}

/** Reads one GitHub REST path (e.g. `/repos/o/r/actions/runs?…`) as JSON. */
export type GithubRead = (path: string) => Promise<unknown>;

const pass = (detail: string): CheckResult => ({ ok: true, detail });
const fail = (detail: string): CheckResult => ({ ok: false, detail });
const short = (sha: string): string => sha.slice(0, SHORT_SHA_LENGTH);

export const parseReleaseTag = (tag: string): TagResult => {
  const version = TAG_PATTERN.exec(tag)?.[1];
  return version === undefined
    ? { ok: false, detail: `tag "${tag}" is not vMAJOR.MINOR.PATCH` }
    : { ok: true, version };
};

export const checkVersions = (version: string, manifests: readonly Manifest[]): CheckResult => {
  if (manifests.length === 0) {
    return fail("no workspace package.json was found");
  }
  const disagreeing = manifests.filter((manifest) => manifest.version !== version);
  if (disagreeing.length > 0) {
    const list = disagreeing.map((manifest) => `${manifest.name} ${manifest.version}`).join(", ");
    return fail(`the tag says ${version}, but ${list}`);
  }
  return pass(`${String(manifests.length)} packages at ${version}`);
};

/** Does `ref` contain `sha`? git's own answer: exit 0 yes, 1 no, anything else an error. */
export const isOnMainline = async (repoDir: string, sha: string, ref: string): Promise<boolean> => {
  const child = Bun.spawn({
    cmd: ["git", "merge-base", "--is-ancestor", sha, ref],
    cwd: repoDir,
    stdout: "ignore",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (exitCode === 0 || exitCode === 1) {
    return exitCode === 0;
  }
  throw new Error(`git merge-base failed (exit ${String(exitCode)}): ${stderr.trim()}`);
};

const RunsSchema = z.object({
  workflow_runs: z.array(
    z.object({ id: z.number(), name: z.string().nullable(), head_branch: z.string().nullable() }),
  ),
});

const JobsSchema = z.object({
  jobs: z.array(
    z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable() }),
  ),
});

type Job = z.infer<typeof JobsSchema>["jobs"][number];

const jobVerdict = (jobs: readonly Job[], name: string): string | null => {
  const found = jobs.find((job) => job.name === name);
  if (found === undefined) {
    return `${name} did not run`;
  }
  if (found.status !== "completed") {
    return `${name} is still ${found.status} — re-run this workflow once CI has finished`;
  }
  return found.conclusion === "success" ? null : `${name} concluded ${String(found.conclusion)}`;
};

export const checkCiGreen = async (read: GithubRead, repo: string, sha: string): Promise<CheckResult> => {
  try {
    const runs = RunsSchema.parse(
      await read(`/repos/${repo}/actions/runs?head_sha=${sha}&event=push&per_page=50`),
    );
    // Newest first, as the API lists them; a re-run keeps its id.
    const run = runs.workflow_runs.find(
      (entry) => entry.name === CI_WORKFLOW_NAME && entry.head_branch === MAINLINE_BRANCH,
    );
    if (run === undefined) {
      return fail(`no CI run on main for ${short(sha)} — merge it to main and let CI finish first`);
    }
    const { jobs } = JobsSchema.parse(await read(`/repos/${repo}/actions/runs/${String(run.id)}/jobs?per_page=100`));
    const problems = REQUIRED_CI_JOBS.map((name) => jobVerdict(jobs, name)).filter(
      (problem): problem is string => problem !== null,
    );
    return problems.length === 0
      ? pass(`${REQUIRED_CI_JOBS.join(" and ")} green on ${short(sha)}`)
      : fail(problems.join("; "));
  } catch (error) {
    return fail(`could not read CI from GitHub: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const githubRead =
  (token: string): GithubRead =>
  async (path) => {
    const response = await fetch(`${GITHUB_API}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`GitHub answered ${String(response.status)} for ${path.split("?")[0] ?? path}`);
    }
    return response.json();
  };

const readManifests = async (): Promise<readonly Manifest[]> => {
  const paths = [...new Glob("packages/*/package.json").scanSync({ cwd: REPO_ROOT })].sort();
  return Promise.all(
    paths.map(async (path) => {
      const manifest = (await Bun.file(join(REPO_ROOT, path)).json()) as Partial<Manifest>;
      return { name: String(manifest.name ?? path), version: String(manifest.version ?? "") };
    }),
  );
};

const report = (label: string, result: CheckResult): boolean => {
  process.stdout.write(`${result.ok ? "PASS" : "FAIL"}  ${label}  ${result.detail}\n`);
  return result.ok;
};

const main = async (): Promise<number> => {
  const env = process.env;
  const tag = parseReleaseTag(env["GITHUB_REF_NAME"] ?? "");
  if (!tag.ok) {
    report("release tag", fail(tag.detail));
    return 1;
  }
  const sha = env["GITHUB_SHA"] ?? "";
  const repo = env["GITHUB_REPOSITORY"] ?? "";
  const token = env["GH_TOKEN"] ?? "";
  if (sha === "" || repo === "" || token === "") {
    report("runner environment", fail("GITHUB_SHA, GITHUB_REPOSITORY and GH_TOKEN must be set"));
    return 1;
  }
  const onMain = await isOnMainline(REPO_ROOT, sha, MAINLINE_REF);
  const results = [
    report("release tag", pass(`v${tag.version}`)),
    report("package versions", checkVersions(tag.version, await readManifests())),
    report("on main", onMain ? pass(`${short(sha)} is on main`) : fail(`${short(sha)} is not on main`)),
    report("ci green", await checkCiGreen(githubRead(token), repo, sha)),
  ];
  return results.every(Boolean) ? 0 : 1;
};

if (import.meta.main) {
  process.exit(await main());
}
