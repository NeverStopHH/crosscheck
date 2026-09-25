/**
 * The why behind a landed-change stop (docs/1.0/landed-changes.md, step 3):
 * whose work on the file the named commits were, asked of the hub.
 *
 * ASKED ONLY ONCE THERE IS A STOP, AND ONLY WITH WHAT IS LEFT. PreToolUse
 * books the stop first (its marker), then calls this with the hook's budget:
 * the request gets the smaller of one hub timeout and the spare the budget
 * still holds after its reserve, and below LANDED_WHY_MIN_MS it is not sent
 * at all. So a slow or old hub costs the why — the stop still goes out, in
 * time — and the vast majority of edits, which stop for nothing, ask nothing.
 *
 * A commit whose author address git could not give is left out of the
 * question rather than sent: one unreadable address would make the hub
 * refuse the whole request, and with it every other commit's why.
 */
import { LANDED_WHY_MIN_MS } from "@crosscheck/connector-core/constants.ts";
import type { HookBudget } from "@crosscheck/connector-core/config/hook-budget.ts";
import { getLandedContexts } from "@crosscheck/connector-core/http/hub.ts";
import type { LandedContextMatch } from "@crosscheck/connector-core/http/hub.ts";
import { namedLandedCommits } from "@crosscheck/connector-core/landed-changes/named-commits.ts";
import type { LandedChanges } from "@crosscheck/connector-core/landed-changes/probe.ts";
import type { HookContext } from "./runner.ts";

const hasAddress = (email: string): boolean => email.includes("@");

export const landedWhyFor = async (
  ctx: HookContext,
  budget: HookBudget,
  file: string,
  landed: LandedChanges,
): Promise<readonly LandedContextMatch[]> => {
  const commits = namedLandedCommits(landed).filter((commit) => hasAddress(commit.authorEmail));
  const timeoutMs = Math.min(ctx.hub.timeoutMs, budget.spareMs());
  if (commits.length === 0 || timeoutMs < LANDED_WHY_MIN_MS) {
    return [];
  }
  try {
    const result = await getLandedContexts(
      { ...ctx.hub, timeoutMs },
      {
        repo: ctx.identity.repoId,
        path: file,
        commits: commits.map((commit) => ({
          sha: commit.sha,
          authorEmail: commit.authorEmail,
          committedAt: commit.committedAt.toISOString(),
        })),
      },
    );
    return result.ok ? result.data : [];
  } catch {
    // Fail open: the stop goes out without its why.
    return [];
  }
};
