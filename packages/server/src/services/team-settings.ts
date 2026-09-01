/**
 * TEAM-level settings for the regression guard (regression-guard Stage 1).
 *
 * WHY THESE TWO ARE SETTINGS AND NOT BEHAVIOUR. Both were decided in a
 * three-person frame, and crosscheck is a product for many teams:
 *
 *   - WHO MAY PIN. The default is "anyone pins anything", which is right at
 *     n=3, where social visibility beats permission machinery and every pin
 *     carries its author's name in `status`. At n=30 the same default rots:
 *     pins appear on code the pinner has never opened, with no findable
 *     owner. `touched_files` is the other setting — you may pin files your
 *     own sessions have actually touched in the window — enforceable from
 *     data the hub already holds, and never a hard block on anything else.
 *   - WHETHER `suspect` NAMES SESSIONS. The default is "sessions", which is
 *     what makes the feature useful. It is a setting because in Germany
 *     tooling from which individual performance or behaviour data can be
 *     derived is mitbestimmungspflichtig (works council) and engages the
 *     GDPR; a team that must switch attribution off should not have to
 *     uninstall the product to do it. `counts_only` answers with counts and
 *     no rows.
 *
 * ABSENT ROW MEANS DEFAULTS, which is why there is no bootstrap INSERT: a
 * hub that has never been configured behaves exactly like one configured
 * with the defaults, and `status` prints the effective values either way, so
 * "what is this team set to" never depends on knowing whether a row exists.
 */
import { eq } from "drizzle-orm";
import {
  TEAM_PIN_POLICIES,
  TEAM_SUSPECT_ATTRIBUTIONS,
} from "@crosscheck/schema";
import type { TeamPinPolicy, TeamSuspectAttribution } from "@crosscheck/schema";

import { teamSettings } from "../db/schema.ts";
import type { Db } from "../db/client.ts";
import type { Clock } from "../types.ts";

/**
 * The vocabulary lives in @crosscheck/schema, where both sides of the wire
 * can read it: the CLI prints the effective values and the hub stores them.
 * Re-exported here so a caller of this service has one import, not two.
 */
export { TEAM_PIN_POLICIES, TEAM_SUSPECT_ATTRIBUTIONS };
export type { TeamPinPolicy, TeamSuspectAttribution };

export interface TeamSettingsView {
  readonly repo: string;
  readonly pinPolicy: TeamPinPolicy;
  readonly suspectAttribution: TeamSuspectAttribution;
  /** Null while the repo has never been configured — the defaults are in use. */
  readonly updatedAt: string | null;
}

/** Nick's decisions for the trial, and the shipped defaults for everyone. */
export const DEFAULT_TEAM_SETTINGS = {
  pinPolicy: "anyone",
  suspectAttribution: "sessions",
} as const satisfies {
  readonly pinPolicy: TeamPinPolicy;
  readonly suspectAttribution: TeamSuspectAttribution;
};

interface Deps {
  readonly db: Db;
  readonly now: Clock;
}

export const readTeamSettings = async (
  deps: Deps,
  repo: string,
): Promise<TeamSettingsView> => {
  const rows = await deps.db
    .select({
      pinPolicy: teamSettings.pinPolicy,
      suspectAttribution: teamSettings.suspectAttribution,
      updatedAt: teamSettings.updatedAt,
    })
    .from(teamSettings)
    .where(eq(teamSettings.repo, repo))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return {
      repo,
      pinPolicy: DEFAULT_TEAM_SETTINGS.pinPolicy,
      suspectAttribution: DEFAULT_TEAM_SETTINGS.suspectAttribution,
      updatedAt: null,
    };
  }
  return {
    repo,
    pinPolicy: row.pinPolicy,
    suspectAttribution: row.suspectAttribution,
    updatedAt: row.updatedAt.toISOString(),
  };
};

export interface WriteTeamSettingsInput {
  readonly repo: string;
  readonly pinPolicy?: TeamPinPolicy;
  readonly suspectAttribution?: TeamSuspectAttribution;
}

/**
 * Upsert, PARTIAL on purpose: a hub operator changing the attribution switch
 * must not silently reset the pin policy to a default they never chose.
 * Omitted fields keep whatever is stored, or the default if nothing is.
 */
export const writeTeamSettings = async (
  deps: Deps,
  input: WriteTeamSettingsInput,
): Promise<TeamSettingsView> => {
  const current = await readTeamSettings(deps, input.repo);
  const next = {
    repo: input.repo,
    pinPolicy: input.pinPolicy ?? current.pinPolicy,
    suspectAttribution: input.suspectAttribution ?? current.suspectAttribution,
    updatedAt: deps.now(),
  };
  await deps.db
    .insert(teamSettings)
    .values(next)
    .onConflictDoUpdate({
      target: teamSettings.repo,
      set: {
        pinPolicy: next.pinPolicy,
        suspectAttribution: next.suspectAttribution,
        updatedAt: next.updatedAt,
      },
    });
  return { ...next, updatedAt: next.updatedAt.toISOString() };
};
