/**
 * `crosscheck noise [<id>]` and `crosscheck helpful [<id>]` — one word, typed
 * beside a session that just got an intervention (1.0 spec 07 §3.2, §12).
 * Each is the one-word shortcut for a key of `crosscheck pilot label`: `n`
 * and `h`. The walk then no longer offers what the word labelled.
 *
 * TWO SHORTCUTS, ONE GESTURE (second review, M6). Noise alone had the
 * in-the-moment word and helpful only the walk after the session, so the
 * easier verdict was the negative one and precision was pulled down by the
 * asymmetry itself. A matching shortcut removes that at the source; marking
 * which path each label came from would only have measured the bias while
 * leaving it in the figure.
 *
 * NO TEXT, NO QUESTION, NO SURVEY (§8.3). The word is the whole message. A
 * measurement that interrupts somebody to ask how the measurement is going
 * has changed the thing it measures, so this never prompts for anything; a
 * person who wants to say WHY uses the walk, where Shift adds a sentence.
 *
 * WHICH DELIVERY, resolved from as little as possible:
 *   · no id — the caller's own unasked deliveries to the sessions LIVE ON THIS
 *     MACHINE for this repo, inside NOISE_MARK_WINDOW_MINUTES. Exactly one is
 *     labelled; several are listed and the person names one, because a
 *     guessed label is noise about noise.
 *   · a delivery id (`hd_…`) — labelled as named.
 *   · anything else — the work context or claim id the hint PRINTED, which is
 *     the only id a person ever saw: its newest delivery to the caller.
 *
 * A HINT STILL ON THIS MACHINE (07 §13.11, review M2), as `crosscheck
 * followed` handles it: the hub is asked first; only when it does not know a
 * delivery the spool holds does the one live session of this checkout send
 * its own held records and the label is asked for once more — and "nothing
 * with that id reached you" is never said of a hint this machine still holds.
 *
 * A PERSON AT A TERMINAL, never an agent (D3) — as a rule this command keeps,
 * not a fact the hub can check. The gate is the TTY evidence `crosscheck pin`
 * uses, with the same stated limit: a pty wrapper passes it, and the raw key
 * can post the route, so what it buys is that an agent does not do this by
 * accident or by default. Nothing at the hub tells a person's label from an
 * agent's acting with the same key (07 §12.9).
 */
import {
  EXIT_FAIL,
  EXIT_OK,
  EXIT_UNREACHABLE,
  EXIT_USAGE,
  NOISE_MARK_WINDOW_MINUTES,
  OUTCOME_FLUSH_BUDGET_MS,
} from "@crosscheck/connector-core/constants.ts";
import { loadConfig } from "@crosscheck/connector-core/config/config.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { resolveRepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import type { RepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import {
  getMarkCandidates,
  postPilotMark,
} from "@crosscheck/connector-core/http/pilot.ts";
import type { MarkCandidates, MarkResult } from "@crosscheck/connector-core/http/pilot.ts";
import type { HubContext, HubResult } from "@crosscheck/connector-core/http/client.ts";
import {
  answerAfterSendingHeld,
  heldDeliveryIdOf,
  withHeldCandidates,
} from "@crosscheck/connector-core/spool/held-deliveries.ts";
import type { HeldRetry } from "@crosscheck/connector-core/spool/held-deliveries.ts";
import { readLiveSessionStates } from "@crosscheck/connector-core/state/session-state.ts";
import { SAFE_ID_PATTERN } from "@crosscheck/schema";
import type { PilotInterventionLabel } from "@crosscheck/schema";

import { heldLine } from "./outcome-render.ts";
import { agentHostRefusalLine, personGate } from "./agent-host.ts";
import { defaultInteractiveProbe } from "./pin.ts";
import type { InteractiveProbe } from "./pin.ts";
import {
  candidateListLines,
  labelStandsLine,
  markAnswerLine,
  markFailureLine,
  noLiveSessionLine,
  nothingRecentLine,
  refNeverReachedLine,
} from "./pilot-mark.ts";
import type { ShortcutCommand } from "./pilot-mark.ts";
import type { CliResult } from "./login.ts";

/** The label each command sends: the walk's `n` key and its `h` key, as one word. */
const NOISE_LABEL: PilotInterventionLabel = "noise";
const HELPFUL_LABEL: PilotInterventionLabel = "helpful";

interface LabelShortcut {
  readonly command: ShortcutCommand;
  readonly label: PilotInterventionLabel;
  readonly usage: string;
}

const usageFor = (command: ShortcutCommand, key: string, need: string): string =>
  [
    `usage: crosscheck ${command} [<id>]`,
    "",
    `  One word, typed beside a session that got an intervention it ${need}:`,
    `  labels that pointer ${command} for this repo's pilot — the shortcut for`,
    `  \`crosscheck pilot label\`'s ${key} key, which also takes the other labels`,
    "  and a reason.",
    "",
    "  With no id it finds the one that reached a live session of this repo on",
    "  this machine in the last hour, and lists them if there were several.",
    "  With an id, name the work context or claim the hint printed (wc_…,",
    "  clm_…) or a delivery id (hd_…). No text and no question — the word is",
    "  the whole message.",
    "",
  ].join("\n");

export const NOISE_USAGE = usageFor("noise", "n", "did not need");
export const HELPFUL_USAGE = usageFor("helpful", "h", "was glad of");

const NOISE: LabelShortcut = { command: "noise", label: NOISE_LABEL, usage: NOISE_USAGE };
const HELPFUL: LabelShortcut = { command: "helpful", label: HELPFUL_LABEL, usage: HELPFUL_USAGE };

const NOT_CONFIGURED = "not configured — run `crosscheck login <hubUrl>`\n";
const NOT_A_REPO = "not a git repository — labels are repo-scoped\n";

const agentRefusal = (command: ShortcutCommand): string =>
  [
    `a ${command} label needs a person at a terminal, and this process has none.`,
    "",
    "A label is the pilot's only human verdict on whether an intervention was",
    "worth it. An agent labelling the product's own interventions would be the",
    "product grading itself, so an agent may not make one, even at your request.",
    "",
    "Run the same command yourself in a terminal.",
    "",
  ].join("\n");

const DELIVERY_ID_PREFIX = "hd_";

const HUB_KIND = "hint_delivery" as const;

const failed = (result: Extract<HubResult<unknown>, { ok: false }>): CliResult => ({
  stdout: markFailureLine(result.kind, result.message),
  exitCode: result.kind === "network" ? EXIT_UNREACHABLE : EXIT_FAIL,
});

/** Where a label is recorded: the hub, and the checkout whose live session may send what is held. */
interface Target {
  readonly ctx: HubContext;
  readonly identity: RepoIdentity;
  /** The caller's developer key, whose held deliveries alone are theirs (LOW-9); null when the config predates it. */
  readonly developerId: string | null;
}

const UNKNOWN_REF = "unknown_ref";

const noCandidates = (result: HubResult<MarkCandidates>): boolean => result.ok && result.data.candidates.length === 0;

/** The hub's answer — after sending what this machine holds, when the hub did not know the ref (review M2). */
const askHub = async <T>(
  target: Target,
  ref: string,
  call: (about: string) => Promise<HubResult<T>>,
  isUnknown: HeldRetry<T>["isUnknown"],
): Promise<{ readonly held: CliResult } | { readonly result: HubResult<T> }> => {
  const { ctx, identity } = target;
  const answer = await answerAfterSendingHeld(
    { hub: ctx, identity, ref, budgetMs: OUTCOME_FLUSH_BUDGET_MS, call, isUnknown },
    await call(ref),
  );
  return answer.kind === "held"
    ? { held: { stdout: heldLine(answer.why), exitCode: EXIT_FAIL } }
    : { result: answer.result };
};

const mark = async (target: Target, deliveryId: string, shortcut: LabelShortcut): Promise<CliResult> => {
  // the delivery named, or — when it cannot be sent now — the same pointer's twin on the hub (round-5 LOW-3)
  const call = (onDelivery: string): Promise<HubResult<MarkResult>> =>
    postPilotMark(target.ctx, {
      repo: target.identity.repoId,
      refKind: HUB_KIND,
      refId: onDelivery,
      label: shortcut.label,
    });
  const asked = await askHub(target, deliveryId, call, (result) => !result.ok && result.code === UNKNOWN_REF);
  if ("held" in asked) {
    return asked.held;
  }
  if (!asked.result.ok) {
    return failed(asked.result);
  }
  return {
    stdout:
      markAnswerLine(HUB_KIND, deliveryId, asked.result.data, shortcut.command) +
      labelStandsLine(asked.result.data),
    exitCode: EXIT_OK,
  };
};

/**
 * The ref a hint printed: today's delivery of it still held in the sending session's own spool,
 * first (07 §13.12, review H-A) — else its newest delivery the hub has, whenever it was.
 */
const markByRef = async (target: Target, ref: string, shortcut: LabelShortcut): Promise<CliResult> => {
  const held = await heldDeliveryIdOf(target.ctx, target.identity, ref, target.developerId);
  if (held !== null) {
    return mark(target, held, shortcut);
  }
  const call = (about: string): Promise<HubResult<MarkCandidates>> =>
    getMarkCandidates(target.ctx, { repo: target.identity.repoId, ref: about });
  const asked = await askHub(target, ref, call, noCandidates);
  if ("held" in asked) {
    return asked.held;
  }
  if (!asked.result.ok) {
    return failed(asked.result);
  }
  const [newest] = asked.result.data.candidates;
  return newest === undefined
    ? { stdout: refNeverReachedLine(ref), exitCode: EXIT_OK }
    : mark(target, newest.id, shortcut);
};

/**
 * No id: the one recent delivery to a session live on this machine — the hub's and those still
 * held in those sessions' own spools, one per pointer (07 §13.12, review H-A).
 */
const markRecent = async (target: Target, shortcut: LabelShortcut): Promise<CliResult> => {
  const { ctx, identity } = target;
  const now = ctx.now();
  const scan = await readLiveSessionStates(ctx.home, ctx.hubUrl, identity.repoId, now);
  const sessions = scan.states.map((state) => state.crosscheckSessionId);
  if (sessions.length === 0) {
    return { stdout: noLiveSessionLine(shortcut.command), exitCode: EXIT_OK };
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
    scan.states,
    listed.data,
    NOISE_MARK_WINDOW_MINUTES,
    target.developerId,
  );
  const [only] = candidates;
  if (only === undefined) {
    return {
      stdout: nothingRecentLine(NOISE_MARK_WINDOW_MINUTES, shortcut.command),
      exitCode: EXIT_OK,
    };
  }
  if (candidates.length > 1 || more) {
    return {
      stdout: candidateListLines(candidates, more, NOISE_MARK_WINDOW_MINUTES, now, shortcut.command),
      exitCode: EXIT_OK,
    };
  }
  return mark(target, only.id, shortcut);
};

const runShortcut = async (
  shortcut: LabelShortcut,
  argv: readonly string[],
  env: Env,
  cwd: string,
  isInteractive: InteractiveProbe,
): Promise<CliResult> => {
  const [id, ...extra] = argv;
  if (extra.length > 0 || (id !== undefined && !SAFE_ID_PATTERN.test(id))) {
    return { stdout: shortcut.usage, exitCode: EXIT_USAGE };
  }
  const gate = personGate(env, isInteractive);
  if (!gate.isPerson) {
    return { stdout: `${agentHostRefusalLine(gate)}${agentRefusal(shortcut.command)}`, exitCode: EXIT_USAGE };
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
  const target: Target = { ctx, identity, developerId: config.developerId };
  if (id === undefined) {
    return markRecent(target, shortcut);
  }
  return id.startsWith(DELIVERY_ID_PREFIX) ? mark(target, id, shortcut) : markByRef(target, id, shortcut);
};

export const runNoise = (
  argv: readonly string[],
  env: Env,
  cwd: string,
  isInteractive: InteractiveProbe = defaultInteractiveProbe,
): Promise<CliResult> => runShortcut(NOISE, argv, env, cwd, isInteractive);

export const runHelpful = (
  argv: readonly string[],
  env: Env,
  cwd: string,
  isInteractive: InteractiveProbe = defaultInteractiveProbe,
): Promise<CliResult> => runShortcut(HELPFUL, argv, env, cwd, isInteractive);
