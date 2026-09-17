/**
 * `crosscheck revalidate` — D5's default, and the cost it pays off.
 *
 * Revalidation happens where somebody asks for it: the MCP trigger asks
 * inside `get_diagnosis`, which leaves a repo NOBODY PULLS A DIAGNOSIS FROM
 * never revalidated, every claim in it reading `unknown` forever. D5 names
 * that cost and takes "both, the CLI manual" as its default. This is the
 * manual half.
 *
 * IT IS A PULL, LIKE `pin` AND `suspect`. A person types it; no hook, no
 * budget, no injection, identical on every connector. It spends the SAME
 * bounded git work the MCP leg does, per tree, and reports what it measured.
 *
 * IT PRINTS COUNTS — no claim id, no claim body, no path, no teammate, not
 * even the repo. That is a decision rather than an omission: the question a
 * person types here is "how much of what we know still holds against this
 * code", which is a number, and every sentence behind a downgrade is one
 * `get_diagnosis` away where a reader asked for it.
 *
 * EXACTLY ONE UNTRUSTED SLOT, and it is the hub's failure message
 * (`hubFailureLine` below). Everything else is a renderer-owned literal, a
 * validity enum word or an integer. Registered as `cli-claim-revalidate` and
 * attacked through that one slot by the shared corpus.
 *
 * NOTHING IS VOUCHED FOR ON A FAILURE. A hub that cannot answer, a checkout
 * with no default branch, a tree from another repository — each ends with a
 * sentence saying currency is UNKNOWN, never with a claim marked current on
 * the strength of a measurement nobody took.
 */
import {
  CLAIM_REVALIDATE_MAX_CONTEXTS,
  EXIT_FAIL,
  EXIT_OK,
  EXIT_UNREACHABLE,
  MAX_HUB_MESSAGE_CHARS,
} from "@crosscheck/connector-core/constants.ts";
import { bareUntrusted } from "@crosscheck/connector-core/briefing/sanitize.ts";
import { loadConfig } from "@crosscheck/connector-core/config/config.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import {
  planClaimRevalidation,
  readClaimDrift,
} from "@crosscheck/connector-core/flows/claim-revalidation.ts";
import { resolveDefaultBranchRef } from "@crosscheck/connector-core/git/default-branch.ts";
import { resolveRefCommit } from "@crosscheck/connector-core/git/claim-drift.ts";
import { resolveRepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import {
  getDiagnosis,
  getWorkContexts,
  reportClaimRevalidations,
} from "@crosscheck/connector-core/http/hub.ts";
import type { HubContext } from "@crosscheck/connector-core/http/hub.ts";
import type { CliResult } from "./login.ts";

export const REVALIDATE_USAGE = [
  "usage: crosscheck revalidate",
  "",
  "  Asks whether the code under this repo's recorded claims has moved, for",
  "  the most recent work contexts, and records what this clone measured.",
  "",
  "  It is the manual half of the same check `get_diagnosis` runs when an",
  "  agent pulls a tree — so a repo nobody pulls from stops reading `unknown`",
  "  forever. Ranges are asked against the DEFAULT BRANCH, never your HEAD:",
  "  your unmerged work must not mark a teammate's claim stale for the team.",
  "",
  "  It prints counts. Which claims went stale, and the commits that did it,",
  "  are on the diagnosis — pull the tree to read them.",
  "",
].join("\n");

const NOT_CONFIGURED = "not configured — run `crosscheck login <hubUrl>`\n";
const NOT_A_REPO =
  "not a git repository — revalidate compares a recorded commit against this repo's default branch\n";
const NO_DEFAULT_REF =
  "this checkout has no default branch to compare against (try `git fetch origin`) — " +
  "whether these claims still hold is UNKNOWN, not that they do\n";

/**
 * THE ONE SLOT ON THIS SURFACE THAT IS NOT OURS — a failure string the HUB
 * chose, printed back so a person can act on it.
 *
 * Everything else this command prints is a renderer-owned literal, a validity
 * ENUM WORD (`ClaimValidityStateSchema` is a strict z.enum, so a hub cannot
 * put prose there — the row fails to parse first) or an integer. This is the
 * exception, and it is the shape MAX_HUB_MESSAGE_CHARS exists for in its own
 * words: "a string THE HUB chose, as a tool prints it back". Through
 * `bareUntrusted`, so a hostile hub's error message cannot carry control
 * characters or renderer structure into the reader's terminal.
 */
export const hubFailureLine = (message: string): string =>
  `hub unreachable: ${bareUntrusted(message, MAX_HUB_MESSAGE_CHARS)} — ` +
  "whether these claims still hold is UNKNOWN\n";

/** What one run measured. Every field is a count; nothing here is text. */
export interface RevalidationRun {
  /** Work contexts this run had something to measure in. */
  readonly contextsMeasured: number;
  /** Work contexts it walked — the honest denominator. */
  readonly contextsWalked: number;
  /** Whether the walk itself hit its bound, so older trees went unread. */
  readonly walkWasCut: boolean;
  /** Claims a reading was recorded for. */
  readonly claimsRevalidated: number;
  /** (commit, path-set) groups a per-tree bound could not reach. */
  readonly groupsCut: number;
  /** How many claims now read as each state, as the hub derived them. */
  readonly states: Readonly<Record<string, number>>;
}

const stateSentence = (states: Readonly<Record<string, number>>): string => {
  const named = Object.entries(states)
    .filter(([, n]) => n > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([state, n]) => `${String(n)} ${state}`);
  return named.length === 0 ? "none" : named.join(", ");
};

export const renderRevalidation = (run: RevalidationRun): string => {
  const lines = [
    `revalidated ${String(run.contextsMeasured)} of ${String(run.contextsWalked)} work contexts`,
  ];
  lines.push(
    run.claimsRevalidated === 0
      ? "nothing was measured: no claim in them is bound to a commit this clone could check"
      : `${String(run.claimsRevalidated)} claims measured — ${stateSentence(run.states)}`,
  );
  // THE CUTS, BOTH OF THEM, NAMED WHENEVER THEY HAPPENED. A bound spent in
  // silence is a coverage claim nobody made (state/capture-health.ts).
  if (run.walkWasCut) {
    lines.push(
      `only the ${String(CLAIM_REVALIDATE_MAX_CONTEXTS)} most recent work contexts were read; older trees were not`,
    );
  }
  if (run.groupsCut > 0) {
    lines.push(
      `${String(run.groupsCut)} commit/file groups were past this run's git budget and stay as they were`,
    );
  }
  return `${lines.join("\n")}\n`;
};

interface Progress {
  contextsMeasured: number;
  claimsRevalidated: number;
  groupsCut: number;
  readonly states: Record<string, number>;
}

/**
 * One tree, measured and reported. Every failure is LOCAL to the tree: a
 * context the hub will not hand over, or a report it will not record, costs
 * that tree's reading and never the run — the alternative is a command that
 * gives up half way and prints a number smaller than what it actually did.
 */
const revalidateOne = async (
  ctx: HubContext,
  root: string,
  repoId: string,
  refCommit: string,
  workContextId: string,
  progress: Progress,
): Promise<void> => {
  const tree = await getDiagnosis(ctx, workContextId);
  if (!tree.ok) {
    return;
  }
  // ANOTHER REPOSITORY'S HISTORY IS NOT THIS CLONE'S TO JUDGE — the same
  // refusal the MCP leg makes, for the same reason: this checkout can only
  // say "unknown" about commits it has never held, and that reading would
  // still overwrite a teammate's real one.
  if (tree.data.repo !== undefined && tree.data.repo !== repoId) {
    return;
  }
  const plan = planClaimRevalidation(tree.data);
  if (plan.total === 0) {
    return;
  }
  const readings = await readClaimDrift(root, refCommit, plan);
  progress.groupsCut += readings.total - readings.revalidated;
  const reported = await reportClaimRevalidations(ctx, repoId, readings);
  if (!reported.ok) {
    return;
  }
  progress.contextsMeasured += 1;
  progress.claimsRevalidated += readings.entries.length;
  // The states are the HUB'S verdicts on the rows it just wrote, not a second
  // opinion derived here: a refused downgrade comes back `stale`, which is
  // the truth about the claim rather than the truth about the request.
  for (const validity of Object.values(reported.data.validities)) {
    progress.states[validity.state] =
      (progress.states[validity.state] ?? 0) + 1;
  }
};

export const runRevalidate = async (
  _argv: readonly string[],
  env: Env,
  cwd: string,
): Promise<CliResult> => {
  const identity = await resolveRepoIdentity(cwd);
  const config = await loadConfig({ env, repoRoot: identity?.root });
  if (config === null) {
    return { stdout: NOT_CONFIGURED, exitCode: EXIT_OK };
  }
  if (identity === null) {
    return { stdout: NOT_A_REPO, exitCode: EXIT_FAIL };
  }
  const ctx: HubContext = {
    hubUrl: config.hubUrl,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    home: config.home,
    repoKey: repoKey(config.hubUrl, identity.repoId),
    now: () => new Date(),
  };
  const contexts = await getWorkContexts(ctx, identity.repoId, {
    limit: CLAIM_REVALIDATE_MAX_CONTEXTS,
  });
  if (!contexts.ok) {
    // THREE outcomes, never two — `suspect`'s rule. A hub that could not
    // answer must never read like a hub that answered "everything is fine".
    return {
      stdout: hubFailureLine(contexts.message),
      exitCode: contexts.kind === "network" ? EXIT_UNREACHABLE : EXIT_FAIL,
    };
  }
  const defaultRef = await resolveDefaultBranchRef(identity.root);
  const refCommit =
    defaultRef === null
      ? null
      : await resolveRefCommit(identity.root, defaultRef);
  if (refCommit === null) {
    return { stdout: NO_DEFAULT_REF, exitCode: EXIT_FAIL };
  }
  const progress: Progress = {
    contextsMeasured: 0,
    claimsRevalidated: 0,
    groupsCut: 0,
    states: {},
  };
  for (const context of contexts.data) {
    await revalidateOne(
      ctx,
      identity.root,
      identity.repoId,
      refCommit,
      context.id,
      progress,
    );
  }
  return {
    stdout: renderRevalidation({
      contextsMeasured: progress.contextsMeasured,
      contextsWalked: contexts.data.length,
      walkWasCut: contexts.data.length >= CLAIM_REVALIDATE_MAX_CONTEXTS,
      claimsRevalidated: progress.claimsRevalidated,
      groupsCut: progress.groupsCut,
      states: progress.states,
    }),
    exitCode: EXIT_OK,
  };
};
