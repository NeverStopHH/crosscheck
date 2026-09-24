/**
 * `doctor`'s landed-changes line: which landing branches the pre-edit stop
 * watches in THIS clone, and every reason it cannot see them
 * (docs/1.0/landed-changes.md).
 *
 * NEVER SILENT. The stop fails open by design — an unusable list, branches
 * origin does not have, a clone with no origin — and each of those is a stop
 * that silently never fires, which reads exactly like "nothing landed". This
 * line is where that silence gets a name: a WARN where the team's own intent
 * is broken (an unusable list, a named branch this clone lacks), a PASS that
 * says why where there is simply nothing to watch yet.
 */
import {
  LANDING_BRANCHES_FIELD,
  readLandingBranches,
  resolveLandingRefs,
} from "@crosscheck/connector-core/landed-changes/landing-branches.ts";
import type { LandingBranchesSetting } from "@crosscheck/connector-core/landed-changes/landing-branches.ts";
import { readRepoState } from "@crosscheck/connector-core/landed-changes/git-queries.ts";
import {
  LANDED_GIT_TIMEOUT_MS,
  LANDED_RECENT_WORKING_DAYS,
  REPO_CONFIG_FILE,
} from "@crosscheck/connector-core/constants.ts";

import type { Check } from "./doctor.ts";

const NAME = "landed changes";

const WHAT_IT_DOES =
  `an edit stops once for a teammate change landed there that this checkout lacks, ` +
  `or that landed in the last ${String(LANDED_RECENT_WORKING_DAYS)} working days`;

const pass = (detail: string): Check => ({ level: "PASS", name: NAME, detail });
const warn = (detail: string): Check => ({ level: "WARN", name: NAME, detail });

const listed = (branches: readonly string[]): string => branches.join(", ");

const configuredCheck = (
  setting: Extract<LandingBranchesSetting, { kind: "configured" }>,
  found: readonly string[],
): Check => {
  if (setting.branches.length === 0) {
    return pass(`switched off ("${LANDING_BRANCHES_FIELD}": [] in ${REPO_CONFIG_FILE})`);
  }
  const missing = setting.branches.filter((name) => !found.includes(name));
  if (found.length === 0) {
    return warn(
      `none of the landing branches in ${REPO_CONFIG_FILE} (${listed(setting.branches)}) is on origin ` +
        "in this clone — nothing can be checked until they are fetched",
    );
  }
  return missing.length === 0
    ? pass(`${listed(found)} (from ${REPO_CONFIG_FILE}) — ${WHAT_IT_DOES}`)
    : warn(
        `${listed(found)} (from ${REPO_CONFIG_FILE}); not on origin in this clone: ${listed(missing)} — ` +
          "fetch them, or fix the list",
      );
};

export const checkLandedChanges = async (repoRoot: string): Promise<Check> => {
  const setting = await readLandingBranches(repoRoot);
  const [refs, state] = await Promise.all([
    resolveLandingRefs(repoRoot, setting),
    // The probe's own question, so doctor and the stop cannot disagree.
    readRepoState({ root: repoRoot, file: "", timeoutMs: LANDED_GIT_TIMEOUT_MS, isCancelled: () => false }),
  ]);
  if (refs === null || state === null) {
    return warn("git did not answer, so the landed-change stop fails open in this clone");
  }
  if (state.isShallow) {
    return warn(
      "this is a shallow clone, so the landed-change stop stays silent here: its oldest commit reads " +
        "as touching every file — run git fetch --unshallow to give it the history it needs",
    );
  }
  const found = refs.map((ref) => ref.branch);
  if (setting.kind === "configured") {
    return configuredCheck(setting, found);
  }
  // Nothing to watch YET is not a fault: a brand-new repo has no branch on
  // origin, and any real clone has origin's default branch. Named as PASS,
  // with the one case that IS a blind spot spelled out — a remote that is
  // not called `origin`.
  if (found.length === 0) {
    return pass(
      "nothing to watch yet: this clone has no default branch from origin (nothing fetched, " +
        "or the remote is not named origin) — the landed-change stop starts once it does",
    );
  }
  return setting.kind === "invalid"
    ? warn(`${setting.reason}; auto-detection is used instead (${listed(found)})`)
    : pass(
        `${listed(found)} (auto-detected: the default branch, plus staging and develop when origin has them; ` +
          `name your own with "${LANDING_BRANCHES_FIELD}" in ${REPO_CONFIG_FILE}) — ${WHAT_IT_DOES}`,
      );
};
