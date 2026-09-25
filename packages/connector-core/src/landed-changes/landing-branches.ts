/**
 * The branches work LANDS on — where a finished change is merged — for this
 * repo (docs/1.0/landed-changes.md, decision 4).
 *
 * THE TEAM NAMES THEM. Not every company has `main` and `staging`; some land
 * on `develop`, some on `integration`, some only on `main`. The committed
 * `.crosscheck.json` may list them — `"landingBranches": ["main", "staging"]`
 * — and an empty list switches landed-change warnings off. Without a list,
 * auto-detection takes the default branch (origin/HEAD, else main, else
 * master) plus whichever of WELL_KNOWN_LANDING_BRANCHES origin has.
 *
 * READ SEPARATELY FROM THE REST OF THE FILE, AND LENIENTLY. `.crosscheck.json`
 * is also where every hook learns the hub URL (config/repo-config.ts), so
 * this field must never be able to make that file unreadable: a typo here
 * would otherwise switch every hook off without a word. An invalid list is
 * reported as such (for `doctor`) and treated as auto-detection — a warning
 * about the default branch is closer to what the team meant than none.
 *
 * ALWAYS FULL REFS. `refs/remotes/origin/staging`, never `origin/staging`:
 * a local branch that happens to be named `origin/staging` would shadow the
 * short form, and these refs go straight back into git.
 */
import { z } from "zod";

import { readJsonOrNull } from "../config/paths.ts";
import { repoConfigPath } from "../config/repo-config.ts";
import {
  LANDED_GIT_TIMEOUT_MS,
  MAX_LANDING_BRANCHES,
  WELL_KNOWN_LANDING_BRANCHES,
} from "../constants.ts";
import { runGitOutcome } from "../git/git.ts";

export const LANDING_BRANCHES_FIELD = "landingBranches";

const ORIGIN_PREFIX = "refs/remotes/origin/";
const ORIGIN_HEAD = `${ORIGIN_PREFIX}HEAD`;
const DEFAULT_BRANCH_FALLBACKS: readonly string[] = ["main", "master"];
const MAX_BRANCH_NAME_CHARS = 100;

/**
 * A branch name git cannot read as a flag, a range or a pattern: segments of
 * ref-alphabet characters joined by single slashes, starting with a letter
 * or digit, never `..`, never ending in `.` or `.lock`.
 */
const BRANCH_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._-]+)*$/;

export const isBranchName = (name: string): boolean =>
  name.length <= MAX_BRANCH_NAME_CHARS &&
  BRANCH_NAME_PATTERN.test(name) &&
  !name.includes("..") &&
  !name.endsWith(".") &&
  !name.endsWith(".lock");

const LandingBranchesSchema = z
  .array(z.string().refine(isBranchName))
  .max(MAX_LANDING_BRANCHES);

export type LandingBranchesSetting =
  | { readonly kind: "configured"; readonly branches: readonly string[] }
  | { readonly kind: "auto" }
  | { readonly kind: "invalid"; readonly reason: string };

export interface LandingRef {
  /** As the team says it: `staging`. */
  readonly branch: string;
  /** As git is handed it: `refs/remotes/origin/staging`. */
  readonly ref: string;
  /** The commit it points at in this clone — what a cached answer is keyed on. */
  readonly tip: string;
}

const INVALID_REASON =
  `${LANDING_BRANCHES_FIELD} must be a list of at most ${String(MAX_LANDING_BRANCHES)} branch names ` +
  "(letters, digits, . _ - and single slashes; no leading dash, no ..)";

/** The setting in a parsed `.crosscheck.json` (or null for no file). */
export const parseLandingBranches = (repoConfig: unknown): LandingBranchesSetting => {
  if (
    repoConfig === null ||
    typeof repoConfig !== "object" ||
    !(LANDING_BRANCHES_FIELD in repoConfig)
  ) {
    return { kind: "auto" };
  }
  const parsed = LandingBranchesSchema.safeParse(
    (repoConfig as Record<string, unknown>)[LANDING_BRANCHES_FIELD],
  );
  return parsed.success
    ? { kind: "configured", branches: [...new Set(parsed.data)] }
    : { kind: "invalid", reason: INVALID_REASON };
};

export const readLandingBranches = async (repoRoot: string): Promise<LandingBranchesSetting> =>
  parseLandingBranches(await readJsonOrNull(repoConfigPath(repoRoot)));

/**
 * What one origin has, as far as the landing branches go — read from this
 * clone's remote-tracking refs for the stop, and from origin itself
 * (`git ls-remote`) for the background fetch (fetch-worker.ts). ONE shape and
 * one selection rule for both, so the fetch and the stop cannot disagree about
 * which branches matter.
 */
export interface OriginRefs {
  /** Branch name → the commit it points at. */
  readonly existing: ReadonlyMap<string, string>;
  /** The branch origin/HEAD points at, when it is a symref. */
  readonly headBranch: string | null;
}

/**
 * One bounded git call over every name that could matter. Null = git did
 * not answer (not a repository, no git, deadline) — which is not the same
 * as "origin has none of these", an empty set.
 */
const readOriginRefs = async (
  root: string,
  names: readonly string[],
  timeoutMs: number,
): Promise<OriginRefs | null> => {
  const outcome = await runGitOutcome(
    [
      "for-each-ref",
      "--format=%(refname)\t%(symref)\t%(objectname)",
      ORIGIN_HEAD,
      ...names.map((name) => `${ORIGIN_PREFIX}${name}`),
    ],
    root,
    timeoutMs,
  );
  if (!outcome.ok) {
    return null;
  }
  const rows = outcome.stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split("\t"));
  const branchOf = (ref: string | undefined): string | null =>
    ref?.startsWith(ORIGIN_PREFIX) === true ? ref.slice(ORIGIN_PREFIX.length) : null;
  const head = rows.find(([ref]) => ref === ORIGIN_HEAD);
  const headBranch = branchOf(head?.[1]);
  return {
    existing: new Map(
      rows
        .map(([ref, , tip]): [string | null, string] => [branchOf(ref), tip ?? ""])
        .filter((row): row is [string, string] => row[0] !== null && row[0] !== "HEAD"),
    ),
    headBranch: headBranch !== null && isBranchName(headBranch) ? headBranch : null,
  };
};

/** Where `refs/remotes/origin/<branch>` lives: the one place it is spelled. */
export const landingRefOf = (branch: string): string => `${ORIGIN_PREFIX}${branch}`;

/** Every branch name the selection below could pick, to ask origin about. */
export const landingBranchCandidates = (setting: LandingBranchesSetting): readonly string[] =>
  setting.kind === "configured"
    ? setting.branches
    : [...DEFAULT_BRANCH_FALLBACKS, ...WELL_KNOWN_LANDING_BRANCHES];

const autoDetected = (origin: OriginRefs): readonly string[] => {
  const defaultBranch =
    origin.headBranch ?? DEFAULT_BRANCH_FALLBACKS.find((name) => origin.existing.has(name));
  const found = WELL_KNOWN_LANDING_BRANCHES.filter((name) => origin.existing.has(name));
  return [...new Set([...(defaultBranch === undefined ? [] : [defaultBranch]), ...found])];
};

/**
 * The landing branches `origin` has, in the team's order: the named ones it
 * has, or the auto-detected ones. An empty list switches everything off.
 */
export const selectLandingBranches = (
  setting: LandingBranchesSetting,
  origin: OriginRefs,
): readonly string[] => {
  if (setting.kind === "configured" && setting.branches.length === 0) {
    return [];
  }
  const branches =
    setting.kind === "configured"
      ? setting.branches.filter((name) => origin.existing.has(name))
      : autoDetected(origin);
  return branches;
};

/**
 * The landing branches this clone can see, in the team's order. Null when
 * git did not answer; empty when there are none (no origin, or none of the
 * named branches fetched, or the team switched the warning off).
 */
export const resolveLandingRefs = async (
  root: string,
  setting: LandingBranchesSetting,
  timeoutMs: number = LANDED_GIT_TIMEOUT_MS,
): Promise<readonly LandingRef[] | null> => {
  if (setting.kind === "configured" && setting.branches.length === 0) {
    return [];
  }
  const origin = await readOriginRefs(root, landingBranchCandidates(setting), timeoutMs);
  if (origin === null) {
    return null;
  }
  return selectLandingBranches(setting, origin).map((branch) => ({
    branch,
    ref: landingRefOf(branch),
    tip: origin.existing.get(branch) ?? "",
  }));
};
