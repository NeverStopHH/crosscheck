/**
 * Whether the landing branches are fetched in the background for this clone
 * (docs/1.0/landed-changes.md, step 2) — on by default, with two off
 * switches that answer to different people:
 *
 * - `"landingFetch": false` in the committed `.crosscheck.json` is THE TEAM's:
 *   a company whose git host counts every fetch, or whose policy forbids a
 *   tool fetching on a developer's behalf.
 * - `CROSSCHECK_LANDING_FETCH=off` is ONE PERSON's: a developer on a metered
 *   line, or one who fetches on their own schedule.
 *
 * And `"landingBranches": []` switches the fetch off with the stop it serves:
 * there is nothing to fetch for.
 *
 * READ LENIENTLY, like `landingBranches` and for the same reason: this file
 * is where every hook learns the hub URL, so a typo here must never make it
 * unreadable. A value that is not `true` or `false` leaves the fetch ON —
 * the documented default — and `doctor` names it.
 */
import { readJsonOrNull } from "../config/paths.ts";
import type { Env } from "../config/paths.ts";
import { repoConfigPath } from "../config/repo-config.ts";
import { LANDING_FETCH_ENV, LANDING_FETCH_OFF } from "../constants.ts";
import { parseLandingBranches } from "./landing-branches.ts";
import type { LandingBranchesSetting } from "./landing-branches.ts";

export const LANDING_FETCH_FIELD = "landingFetch";

export type LandingFetchSwitch =
  | { readonly kind: "on" }
  /** On, because the value in `.crosscheck.json` is unusable; `doctor` warns. */
  | { readonly kind: "invalid" }
  | { readonly kind: "off"; readonly by: "person" | "team" | "no-landing-branches" };

/** Everything the fetch needs from one reading of the repo's config. */
export interface LandingFetchPlan {
  readonly switch: LandingFetchSwitch;
  readonly branches: LandingBranchesSetting;
}

const teamValue = (repoConfig: unknown): unknown =>
  repoConfig !== null && typeof repoConfig === "object" && LANDING_FETCH_FIELD in repoConfig
    ? (repoConfig as Record<string, unknown>)[LANDING_FETCH_FIELD]
    : true;

/**
 * The person's switch is checked first: it is the one that can only ever
 * turn the fetch off, so no team setting can override someone's "not on my
 * machine".
 */
export const parseLandingFetchPlan = (repoConfig: unknown, env: Env): LandingFetchPlan => {
  const branches = parseLandingBranches(repoConfig);
  const team = teamValue(repoConfig);
  const decide = (): LandingFetchSwitch => {
    if (env[LANDING_FETCH_ENV] === LANDING_FETCH_OFF) {
      return { kind: "off", by: "person" };
    }
    if (team === false) {
      return { kind: "off", by: "team" };
    }
    if (branches.kind === "configured" && branches.branches.length === 0) {
      return { kind: "off", by: "no-landing-branches" };
    }
    return team === true ? { kind: "on" } : { kind: "invalid" };
  };
  return { switch: decide(), branches };
};

export const readLandingFetchPlan = async (repoRoot: string, env: Env): Promise<LandingFetchPlan> =>
  parseLandingFetchPlan(await readJsonOrNull(repoConfigPath(repoRoot)), env);
