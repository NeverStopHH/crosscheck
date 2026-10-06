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
 * A DELIVERY STILL ON THIS MACHINE (07 §13.10 #14, §13.11). The command asks
 * the hub FIRST; only when the hub does not know a ref the spool holds does
 * the one live session of this checkout send its own held records, bounded,
 * before asking once more — never a guessed or silent session. "No hint with
 * that id reached you" is never repeated for a delivery the spool still holds;
 * the line says why it is still here.
 *
 * A PERSON AT A TERMINAL, OR THE AGENT (07 §13.13 HIGH-1). A person's word is
 * never overturned by their agent's (§13.12), so which one said it matters,
 * and the agent's Bash tool runs this same command with the same key. At a
 * terminal — the TTY evidence `crosscheck noise` and `pin` use — the word goes
 * to the person's route; with none it goes to the AGENT's, and the line says
 * so and how to make it the person's. Like the label's gate, this is a rule
 * backed by a TTY check, not a wall: a deliberate pty wrapper, or the key
 * posted with curl, still passes it — the same bar as noise (07 §12.9).
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
import type { RepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import type { HubContext, HubResult } from "@crosscheck/connector-core/http/client.ts";
import {
  getMyHintOutcomes,
  isOutcomesNotServed,
  postHintOutcome,
} from "@crosscheck/connector-core/http/hint-outcomes.ts";
import type { RecordedOutcome } from "@crosscheck/connector-core/http/hint-outcomes.ts";
import { getMarkCandidates } from "@crosscheck/connector-core/http/pilot.ts";
import {
  answerAfterSendingHeld,
  heldDeliveryIdOf,
  withHeldCandidates,
} from "@crosscheck/connector-core/spool/held-deliveries.ts";
import type { HeldWhy } from "@crosscheck/connector-core/spool/held-deliveries.ts";
import { readLiveSessionStates } from "@crosscheck/connector-core/state/session-state.ts";
import { MAX_HINT_OUTCOME_REASON_CHARS, SAFE_ID_PATTERN, reasonLength } from "@crosscheck/schema";
import type { HintOutcome, HintOutcomeChannel } from "@crosscheck/schema";

import {
  AGENT_WORD_LINE,
  OUTCOMES_NOT_SERVED_LINE,
  PERSON_DOOR_NOT_SERVED_LINE,
  REASON_REQUIRED_LINE,
  REASON_SECRET_LINE,
  agentHostLine,
  heldLine,
  outcomeRecordedLine,
  reasonTooLongLine,
} from "./outcome-render.ts";
import { personGate } from "./agent-host.ts";
import { defaultInteractiveProbe } from "./pin.ts";
import type { InteractiveProbe } from "./pin.ts";
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
    "  Typed in your own shell it is your word, which your agent's never",
    "  overturns. Where its input is not a terminal (an agent's tool, a pipe,",
    "  or Claude Code's ! prefix), or inside an agent's tool that marks its",
    "  own commands, it is your agent's.",
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

/** Where an outcome is recorded: the hub, and the checkout whose live session may send what is held. */
interface Target {
  readonly ctx: HubContext;
  readonly identity: RepoIdentity;
  /** The person's route at a terminal, the agent's without one (07 §13.13 HIGH-1) or under an agent host (§13.14). */
  readonly via: HintOutcomeChannel;
  /** Said after an agent's word — why it is the agent's; empty after the person's. */
  readonly agentLine: string;
  /** The caller's developer key, whose held deliveries alone are theirs (LOW-9); null when the config predates it. */
  readonly developerId: string | null;
}

const isUnknownRef = (result: HubResult<RecordedOutcome>): boolean => !result.ok && result.code === UNKNOWN_REF;

/**
 * A 404 FROM THE PERSON'S DOOR, ON A HUB THAT RECORDS OUTCOMES (07 §13.13 LOW-7): a hub
 * from before `/person`. Told apart from a hub with no outcomes at all by asking for the
 * caller's own view — a read — and never by posting the word through the agent's door:
 * FAIL CLOSED, nothing is recorded.
 */
const isPersonDoorMissing = async (target: Target, result: HubResult<RecordedOutcome>): Promise<boolean> => {
  if (target.via !== "person" || !isOutcomesNotServed(result)) {
    return false;
  }
  return !isOutcomesNotServed(await getMyHintOutcomes(target.ctx, { repo: target.identity.repoId }));
};

const held = (why: HeldWhy): CliResult => ({ stdout: heldLine(why), exitCode: EXIT_FAIL });

const record = async (
  target: Target,
  ref: string,
  outcome: HintOutcome,
  reason: string | undefined,
): Promise<CliResult> => {
  const { ctx, identity, via } = target;
  // HELD FIRST (07 §13.12, review H-A): today's delivery still held here is named by its own id,
  // so the word never lands on an older delivery of the same ref the hub already has.
  const posted = (await heldDeliveryIdOf(ctx, identity, ref, target.developerId)) ?? ref;
  // At a terminal, the PERSON's route — never overturned by an agent's word; without one, the
  // AGENT's (07 §13.13 HIGH-1): the agent's Bash tool runs this very command with the same key.
  const call = (about: string): Promise<HubResult<RecordedOutcome>> =>
    postHintOutcome(
      ctx,
      { repo: identity.repoId, ref: about, outcome, ...(reason === undefined ? {} : { reason }) },
      via,
    );
  // POST FIRST (07 §13.11): held records are sent only when the hub does not know a ref held here.
  const answer = await answerAfterSendingHeld(
    { hub: ctx, identity, ref: posted, budgetMs: OUTCOME_FLUSH_BUDGET_MS, call, isUnknown: isUnknownRef },
    await call(posted),
  );
  if (answer.kind === "held") {
    return held(answer.why);
  }
  if (!answer.result.ok) {
    return (await isPersonDoorMissing(target, answer.result))
      ? { stdout: PERSON_DOOR_NOT_SERVED_LINE, exitCode: EXIT_FAIL }
      : failed(answer.result);
  }
  return { stdout: `${outcomeRecordedLine(ref, answer.result.data)}${target.agentLine}`, exitCode: EXIT_OK };
};

/**
 * No id: the one recent delivery to a session live on this machine, as `noise` finds it — the hub's
 * and those still held in those sessions' own spools, one per pointer (07 §13.12, review H-A).
 */
const recordRecent = async (target: Target, command: OutcomeCommand, reason: string | undefined): Promise<CliResult> => {
  const { ctx, identity } = target;
  const live = await readLiveSessionStates(ctx.home, ctx.hubUrl, identity.repoId, ctx.now());
  const sessions = live.states.map((state) => state.crosscheckSessionId);
  if (sessions.length === 0) {
    return { stdout: noLiveSessionLine(command), exitCode: EXIT_OK };
  }
  const listed = await getMarkCandidates(ctx, {
    repo: identity.repoId,
    sessions,
    withinMinutes: NOISE_MARK_WINDOW_MINUTES,
  });
  if (!listed.ok) {
    return failed(listed);
  }
  const { candidates, more } = await withHeldCandidates(
    ctx,
    live.states,
    listed.data,
    NOISE_MARK_WINDOW_MINUTES,
    target.developerId,
  );
  const [only] = candidates;
  if (only === undefined) {
    return { stdout: nothingRecentLine(NOISE_MARK_WINDOW_MINUTES, command), exitCode: EXIT_OK };
  }
  if (candidates.length > 1 || more) {
    return {
      stdout: candidateListLines(candidates, more, NOISE_MARK_WINDOW_MINUTES, ctx.now(), command),
      exitCode: EXIT_OK,
    };
  }
  return record(target, only.id, COMMAND_OUTCOME[command], reason);
};

/**
 * WHOSE WORD THIS IS. An agent host's marker comes first and can only DEMOTE (07 §13.14 MEDIUM-2):
 * a pty its tool was given passes the TTY probe, and the environment, which any agent can write,
 * never opens the person's door — it can only take it away. Then the probe (§13.13 HIGH-1). Asked
 * through the one person gate every person-only gesture takes (`personGate`).
 */
const channelOf = (env: Env, isInteractive: InteractiveProbe): Pick<Target, "via" | "agentLine"> => {
  const gate = personGate(env, isInteractive);
  if (gate.isPerson) {
    return { via: "person", agentLine: "" };
  }
  return { via: "agent", agentLine: gate.marker === null ? AGENT_WORD_LINE : agentHostLine(gate.marker) };
};

const runOutcome = async (
  command: OutcomeCommand,
  usage: string,
  argv: readonly string[],
  env: Env,
  cwd: string,
  isInteractive: InteractiveProbe,
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
  const target: Target = {
    ctx,
    identity,
    ...channelOf(env, isInteractive),
    developerId: config.developerId,
  };
  return args.id === undefined
    ? recordRecent(target, command, args.reason)
    : record(target, args.id, COMMAND_OUTCOME[command], args.reason);
};

export const runFollowed = (
  argv: readonly string[],
  env: Env,
  cwd: string,
  isInteractive: InteractiveProbe = defaultInteractiveProbe,
): Promise<CliResult> => runOutcome("followed", FOLLOWED_USAGE, argv, env, cwd, isInteractive);

export const runOverrode = (
  argv: readonly string[],
  env: Env,
  cwd: string,
  isInteractive: InteractiveProbe = defaultInteractiveProbe,
): Promise<CliResult> => runOutcome("overrode", OVERRODE_USAGE, argv, env, cwd, isInteractive);
