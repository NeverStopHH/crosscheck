/**
 * `crosscheck followed [<id>] [--reason "…"]` and `crosscheck overrode [<id>]
 * --reason "…"` — what a hint led to, said by the person it reached (1.0
 * spec 07 §13). The agent says the same through `mark_hint_outcome`.
 *
 * FOLLOWED AND OVERRODE ARE TWO PAIRS OF SHOES. Taking a teammate's decision
 * and deliberately going another way are both a hint that did its job — the
 * reader decided with the teammate's work in view — and neither is noise.
 * An override records WHY, so it needs `--reason`; noise stays the label
 * (`crosscheck noise`), the one word for an off-target hint.
 *
 * WHICH DELIVERY, resolved exactly as `crosscheck noise` resolves it: no id
 * is the one recent delivery to a session live on this machine (several are
 * listed, never guessed); an id is what the hint printed, or a delivery id.
 *
 * A DELIVERY STILL ON THIS MACHINE (07 §13.10, review #14) is sent first,
 * bounded, in a live session's name; and "no hint with that id reached you"
 * is never repeated for a delivery the spool still holds — it reached the
 * person, not yet the hub.
 *
 * NO TERMINAL GATE, and that is a decision rather than an omission. The gate
 * on `noise` keeps an agent from grading the product by default (07 D3); an
 * outcome is the record an agent is ASKED to write, so a person typing it
 * and an agent running it are the same gesture with the same key — and the
 * hub attributes both to that key, nothing more.
 */
import {
  EXIT_FAIL,
  EXIT_OK,
  EXIT_UNREACHABLE,
  EXIT_USAGE,
  NOISE_MARK_WINDOW_MINUTES,
  OUTCOME_FLUSH_BUDGET_MS,
} from "@crosscheck/connector-core/constants.ts";
import { containsSecret } from "@crosscheck/connector-core/capture/secret-scan.ts";
import { loadConfig } from "@crosscheck/connector-core/config/config.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { resolveRepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import type { HubContext, HubResult } from "@crosscheck/connector-core/http/client.ts";
import { isOutcomesNotServed, postHintOutcome } from "@crosscheck/connector-core/http/hint-outcomes.ts";
import { getMarkCandidates } from "@crosscheck/connector-core/http/pilot.ts";
import { holdsUnsentDelivery, sendHeldRecords } from "@crosscheck/connector-core/spool/held-deliveries.ts";
import type { FlushInput } from "@crosscheck/connector-core/spool/flush.ts";
import { readLiveSessionStates } from "@crosscheck/connector-core/state/session-state.ts";
import type { SessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { MAX_HINT_OUTCOME_REASON_CHARS, SAFE_ID_PATTERN, reasonLength } from "@crosscheck/schema";
import type { HintOutcome } from "@crosscheck/schema";

import {
  DELIVERY_HELD_NO_LIVE_SESSION_LINE,
  DELIVERY_STILL_ON_THIS_MACHINE_LINE,
  OUTCOMES_NOT_SERVED_LINE,
  REASON_REQUIRED_LINE,
  REASON_SECRET_LINE,
  outcomeRecordedLine,
  reasonTooLongLine,
} from "./outcome-render.ts";
import { candidateListLines, markFailureLine, noLiveSessionLine, nothingRecentLine } from "./pilot-mark.ts";
import type { CliResult } from "./login.ts";

export const OUTCOME_FLAG_REASON = "--reason";

type OutcomeCommand = "followed" | "overrode";

const COMMAND_OUTCOME: Record<OutcomeCommand, HintOutcome> = {
  followed: "followed",
  overrode: "overrode",
};

const usageFor = (command: OutcomeCommand, reason: string, meaning: string): string =>
  [
    `usage: crosscheck ${command} [<id>] ${reason}`,
    "",
    `  ${meaning}`,
    "  Recorded once per hint; a later word supersedes an earlier one and",
    "  nothing is deleted. It shows in full only in your own crosscheck pilot",
    "  --mine. Others see it only inside totals for a whole past month: the",
    "  team report's, and the teammate's count of how often their work was",
    "  followed — each shown only if, leaving out any one person's words,",
    "  words from at least 3 people remain, so never in a team of three.",
    "",
    "  With no id it finds the one hint that reached a live session of this",
    "  repo on this machine in the last hour, and lists them if there were",
    "  several. With an id, name the work context or claim the hint printed",
    "  (wc_…, clm_…) or a delivery id (hd_…). An off-target hint is noise, the",
    "  person's own label: crosscheck noise.",
    "",
  ].join("\n");

export const FOLLOWED_USAGE = usageFor(
  "followed",
  '[--reason "<sentence>"]',
  "The hint helped: you reused the teammate's decision, stopped duplicate work, or coordinated.",
);
export const OVERRODE_USAGE = usageFor(
  "overrode",
  '--reason "<sentence>"',
  "You saw the hint and deliberately went another way — the reason says why yours was better.",
);

const NOT_CONFIGURED = "not configured — run `crosscheck login <hubUrl>`\n";
const NOT_A_REPO = "not a git repository — outcomes are repo-scoped\n";
/** The hub's refusal for a ref it has no delivery of, for this caller. */
const UNKNOWN_REF = "unknown_ref";

interface OutcomeArgs {
  readonly id: string | undefined;
  readonly reason: string | undefined;
}

const parseOutcomeArgs = (argv: readonly string[]): OutcomeArgs | null => {
  const at = argv.indexOf(OUTCOME_FLAG_REASON);
  const reason = at === -1 ? undefined : argv[at + 1]?.trim();
  const positional = argv.filter((_, index) => at === -1 || (index !== at && index !== at + 1));
  const [id, ...extra] = positional;
  const isBadReason = at !== -1 && (reason === undefined || reason.length === 0);
  const isBadId = id !== undefined && !SAFE_ID_PATTERN.test(id);
  return extra.length > 0 || isBadReason || isBadId ? null : { id, reason };
};

/** Why a reason may not leave the machine, or null when it may. */
const reasonRefusal = (reason: string | undefined): string | null => {
  if (reason === undefined) {
    return null;
  }
  if (reasonLength(reason) > MAX_HINT_OUTCOME_REASON_CHARS) {
    return reasonTooLongLine(reasonLength(reason));
  }
  return containsSecret(reason) ? REASON_SECRET_LINE : null;
};

const failed = (result: Extract<HubResult<unknown>, { ok: false }>): CliResult =>
  isOutcomesNotServed(result)
    ? { stdout: OUTCOMES_NOT_SERVED_LINE, exitCode: EXIT_FAIL }
    : { stdout: markFailureLine(result.kind, result.message), exitCode: result.kind === "network" ? EXIT_UNREACHABLE : EXIT_FAIL };

/** What is true of a held delivery: a live session sends it after its next tool call; with none, the next to start does. */
const stillHere = (hasLiveSession: boolean): CliResult => ({
  stdout: hasLiveSession ? DELIVERY_STILL_ON_THIS_MACHINE_LINE : DELIVERY_HELD_NO_LIVE_SESSION_LINE,
  exitCode: EXIT_FAIL,
});

const record = async (
  ctx: HubContext,
  repo: string,
  ref: string,
  outcome: HintOutcome,
  reason: string | undefined,
  hasLiveSession: boolean,
): Promise<CliResult> => {
  const posted = await postHintOutcome(ctx, { repo, ref, outcome, ...(reason === undefined ? {} : { reason }) });
  if (posted.ok) {
    return { stdout: outcomeRecordedLine(ref, posted.data), exitCode: EXIT_OK };
  }
  return posted.code === UNKNOWN_REF && (await holdsUnsentDelivery(ctx, ref)) ? stillHere(hasLiveSession) : failed(posted);
};

/** The newest live session, in whose name held records are sent; null when none is live. */
const senderOf = (states: readonly SessionState[]): FlushInput | null => {
  const [newest] = [...states].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  return newest === undefined ? null : { sessionId: newest.crosscheckSessionId, developerId: newest.developerId };
};

/** No id: the one recent delivery to a session live on this machine, as `noise` finds it. */
const recordRecent = async (
  ctx: HubContext,
  repo: string,
  states: readonly SessionState[],
  command: OutcomeCommand,
  reason: string | undefined,
): Promise<CliResult> => {
  const sessions = states.map((state) => state.crosscheckSessionId);
  if (sessions.length === 0) {
    return { stdout: noLiveSessionLine(command), exitCode: EXIT_OK };
  }
  const found = await getMarkCandidates(ctx, { repo, sessions, withinMinutes: NOISE_MARK_WINDOW_MINUTES });
  if (!found.ok) {
    return failed(found);
  }
  const { candidates, more } = found.data;
  const [only] = candidates;
  if (only === undefined) {
    return (await holdsUnsentDelivery(ctx, null))
      ? stillHere(true)
      : { stdout: nothingRecentLine(NOISE_MARK_WINDOW_MINUTES, command), exitCode: EXIT_OK };
  }
  if (candidates.length > 1 || more) {
    return {
      stdout: candidateListLines(candidates, more, NOISE_MARK_WINDOW_MINUTES, ctx.now(), command),
      exitCode: EXIT_OK,
    };
  }
  return record(ctx, repo, only.id, COMMAND_OUTCOME[command], reason, true);
};

const runOutcome = async (
  command: OutcomeCommand,
  usage: string,
  argv: readonly string[],
  env: Env,
  cwd: string,
): Promise<CliResult> => {
  const args = parseOutcomeArgs(argv);
  if (args === null) {
    return { stdout: usage, exitCode: EXIT_USAGE };
  }
  if (command === "overrode" && args.reason === undefined) {
    return { stdout: `${REASON_REQUIRED_LINE}${usage}`, exitCode: EXIT_USAGE };
  }
  const refusal = reasonRefusal(args.reason);
  if (refusal !== null) {
    return { stdout: refusal, exitCode: EXIT_USAGE };
  }
  const identity = await resolveRepoIdentity(cwd);
  const config = await loadConfig({ env, repoRoot: identity?.root });
  if (config === null) {
    return { stdout: NOT_CONFIGURED, exitCode: EXIT_OK };
  }
  if (identity === null) {
    return { stdout: NOT_A_REPO, exitCode: EXIT_USAGE };
  }
  const ctx: HubContext = {
    hubUrl: config.hubUrl,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    home: config.home,
    repoKey: repoKey(config.hubUrl, identity.repoId),
    now: () => new Date(),
  };
  const live = await readLiveSessionStates(ctx.home, ctx.hubUrl, identity.repoId, ctx.now());
  await sendHeldRecords(ctx, senderOf(live.states), OUTCOME_FLUSH_BUDGET_MS);
  return args.id === undefined
    ? recordRecent(ctx, identity.repoId, live.states, command, args.reason)
    : record(ctx, identity.repoId, args.id, COMMAND_OUTCOME[command], args.reason, live.states.length > 0);
};

export const runFollowed = (argv: readonly string[], env: Env, cwd: string): Promise<CliResult> =>
  runOutcome("followed", FOLLOWED_USAGE, argv, env, cwd);

export const runOverrode = (argv: readonly string[], env: Env, cwd: string): Promise<CliResult> =>
  runOutcome("overrode", OVERRODE_USAGE, argv, env, cwd);
