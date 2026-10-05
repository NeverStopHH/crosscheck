/**
 * `sharing` — doctor's and status's answer to "why does my agent share
 * nothing?" (connector-core derive/sharing.ts names every cause).
 *
 * The inputs are the three places the answer can live: the live sessions'
 * counters (the scan doctor already made), the ended sessions' counters the
 * per-repo history kept (state/derive-history.ts — without it a doctor run
 * after the editor closed had nothing to read), and the developer's OWN
 * unreviewed drafts on the hub, one GET. A hub that does not answer costs the
 * drafts finding only: no claim about drafts is made from silence.
 *
 * One WARN line per cause found, every one of them pasteable on its own; one
 * PASS line saying what was read when nothing was.
 */
import { countPastRetentionHorizon } from "@crosscheck/connector-core/briefing/draft-nudge.ts";
import { DRAFT_LISTING_CAP } from "@crosscheck/connector-core/constants.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import {
  digestOf,
  sharingFindings,
  sharingSummary,
} from "@crosscheck/connector-core/derive/sharing.ts";
import type { OwnDraftsFact, SharingInput } from "@crosscheck/connector-core/derive/sharing.ts";
import { dueDrafts } from "@crosscheck/connector-core/flows/draft-nudge.ts";
import type { HubContext } from "@crosscheck/connector-core/http/client.ts";
import { getDrafts } from "@crosscheck/connector-core/http/hub.ts";
import { readDeriveHistory } from "@crosscheck/connector-core/state/derive-history.ts";
import type { SessionState } from "@crosscheck/connector-core/state/session-state.ts";

import type { Check } from "./doctor.ts";

const NAME = "sharing";

export interface SharingSources {
  readonly env: Env;
  readonly hub: HubContext;
  readonly repoId: string;
  readonly home: string;
  readonly key: string;
  readonly liveStates: readonly SessionState[];
  readonly now: Date;
}

const readOwnDrafts = async (
  hub: HubContext,
  repoId: string,
  now: Date,
): Promise<OwnDraftsFact | null> => {
  const drafts = await getDrafts(hub, repoId);
  return drafts.ok
    ? {
        listed: drafts.data.length,
        due: dueDrafts(drafts.data, now).length,
        atCap: drafts.data.length >= DRAFT_LISTING_CAP,
        pastHorizon: countPastRetentionHorizon(drafts.data, now),
      }
    : null;
};

export const readSharingInput = async (sources: SharingSources): Promise<SharingInput> => {
  const [history, drafts] = await Promise.all([
    readDeriveHistory(sources.home, sources.key),
    readOwnDrafts(sources.hub, sources.repoId, sources.now),
  ]);
  return {
    env: sources.env,
    live: sources.liveStates.map(digestOf),
    ended: history.sessions,
    drafts,
  };
};

export const sharingChecks = (input: SharingInput): readonly Check[] => {
  const findings = sharingFindings(input);
  return findings.length === 0
    ? [{ level: "PASS", name: NAME, detail: sharingSummary(input) }]
    : findings.map((found) => ({ level: "WARN", name: NAME, detail: found.detail }));
};

/** `crosscheck status`: the first cause, how many more, and where the rest is. */
export const sharingStatusLine = (input: SharingInput): string => {
  const findings = sharingFindings(input);
  const first = findings[0];
  if (first === undefined) {
    return `${NAME}: ${sharingSummary(input)}`;
  }
  const more = findings.length > 1 ? ` (+${String(findings.length - 1)} more)` : "";
  return `${NAME}: ${first.short}${more} — crosscheck doctor says why and what to do`;
};
