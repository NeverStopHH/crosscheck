/**
 * The why behind a landed-change stop (docs/1.0/landed-changes.md, step 3):
 * whose work on the file the named commits were, asked of the hub.
 *
 * ASKED ONLY WHEN THERE IS A STOP, AND ONLY WITH WHAT IS LEFT. PreToolUse
 * starts this the moment GIT has found a change worth stopping for — beside
 * the live tripwire's hub call and the booking, not after them — and uses
 * the answer only if it wins the booking. The request gets the smaller of
 * one hub timeout and the spare the budget still holds after its reserve,
 * and below LANDED_WHY_MIN_MS it is not sent at all. So a slow or old hub
 * costs the why, never the stop; and on a machine whose git spends most of
 * the budget before the probe answers, there is no spare left and the stop
 * goes out without its why. The vast majority of edits, which stop for
 * nothing, ask nothing.
 *
 * A commit the hub's own schema would refuse (an author address git could
 * not give, or one outside its bounds) is left out of the question rather
 * than sent: one unreadable commit would make the hub refuse the whole
 * request, and with it every other commit's why.
 *
 * The same answer names WHO THE STOP TELLS (step 4, decision 11): the
 * developer behind each named commit's address. No answer — not asked, too
 * slow, an older hub — tells nobody, and the stop then says so by saying
 * nothing about it.
 */
import { LandedContextCommitSchema } from "@crosscheck/schema";
import { LANDED_WHY_MIN_MS } from "@crosscheck/connector-core/constants.ts";
import type { HookBudget } from "@crosscheck/connector-core/config/hook-budget.ts";
import { getLandedContexts } from "@crosscheck/connector-core/http/hub.ts";
import type { LandedContextAnswer } from "@crosscheck/connector-core/http/hub.ts";
import { namedLandedCommits } from "@crosscheck/connector-core/landed-changes/named-commits.ts";
import type { LandedChanges } from "@crosscheck/connector-core/landed-changes/probe.ts";
import type { HookContext } from "./runner.ts";

/** No why, and nobody told. */
export const NO_LANDED_ANSWER: LandedContextAnswer = { matches: [], told: [] };

export const landedWhyFor = async (
  ctx: HookContext,
  budget: HookBudget,
  file: string,
  landed: LandedChanges,
): Promise<LandedContextAnswer> => {
  const commits = namedLandedCommits(landed).flatMap((commit) => {
    const parsed = LandedContextCommitSchema.safeParse({
      sha: commit.sha,
      authorEmail: commit.authorEmail,
      committedAt: commit.committedAt.toISOString(),
    });
    return parsed.success ? [parsed.data] : [];
  });
  const timeoutMs = Math.min(ctx.hub.timeoutMs, budget.spareMs());
  if (commits.length === 0 || timeoutMs < LANDED_WHY_MIN_MS) {
    return NO_LANDED_ANSWER;
  }
  try {
    // repoKey "": the why is an extra read, and it keeps out of the sync
    // record — which a request still in flight after its hook returned would
    // otherwise write into a home nobody expects it in.
    const result = await getLandedContexts(
      { ...ctx.hub, timeoutMs, repoKey: "" },
      { repo: ctx.identity.repoId, path: file, commits },
    );
    return result.ok ? result.data : NO_LANDED_ANSWER;
  } catch {
    // Fail open: the stop goes out without its why, and tells nobody.
    return NO_LANDED_ANSWER;
  }
};
