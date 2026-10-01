/**
 * `crosscheck pilot label` — the reader's own verdict on what crosscheck put
 * in front of them unasked (1.0 spec 07 §12).
 *
 * WHY A WALK. The first pilot counted an OPENED pointer as the positive
 * signal, and opening is the model's call, not a person's; `noise` gave a
 * person one word and only the negative one. This walks the caller's own
 * unlabelled interventions on this repo from the last
 * PILOT_LABEL_WINDOW_MINUTES, newest first, and takes ONE KEY each:
 * `h` helpful, `n` noise, `u` unclear, `s` skip, `q` stop. Fast enough to
 * do after a session, which is the whole design constraint: a label nobody
 * gives is a coverage figure, not a precision one.
 *
 * NOTHING ASKS FOR A SENTENCE (§8.3 still refuses a survey). Shift — `H`,
 * `N`, `U` — is how a person says "and here is why"; a lowercase key is the
 * whole gesture. The reason is bounded (MAX_PILOT_LABEL_REASON_CHARS) and
 * secret-scanned HERE, before it leaves the machine: the hub scans again,
 * but a token that reached the hub has already crossed the network.
 *
 * EACH LABEL IS SENT WHEN ITS KEY IS PRESSED, so a stop — `q`, Ctrl-C,
 * Ctrl-D, a closed terminal — loses nothing already said and sends nothing
 * that was not. `s` and a stop record nothing, and the intervention is
 * offered again next run.
 *
 * A PERSON AT A TERMINAL, never an agent (07 PIL-6, D3) — the same gate and
 * the same stated limit as `pin` and `noise`: TTY evidence, not proof. An
 * agent labelling the product's own interventions would be the product
 * grading itself.
 */
import {
  EXIT_FAIL,
  EXIT_OK,
  EXIT_UNREACHABLE,
  EXIT_USAGE,
  PILOT_LABEL_WINDOW_MINUTES,
} from "@crosscheck/connector-core/constants.ts";
import { loadConfig } from "@crosscheck/connector-core/config/config.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { resolveRepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import {
  getUnlabeledInterventions,
  postPilotMark,
} from "@crosscheck/connector-core/http/pilot.ts";
import type { UnlabeledIntervention } from "@crosscheck/connector-core/http/pilot.ts";
import type { HubContext } from "@crosscheck/connector-core/http/client.ts";
import { MAX_PILOT_LABEL_REASON_CHARS, containsSecret } from "@crosscheck/schema";
import type { PilotInterventionLabel } from "@crosscheck/schema";

import { defaultInteractiveProbe } from "./pin.ts";
import type { InteractiveProbe } from "./pin.ts";
import { markFailureLine } from "./pilot-mark.ts";
import {
  decisionEchoLine,
  interventionLine,
  keyPromptLine,
  labelRecordedLine,
  labelRefusedLine,
  nothingToLabelLine,
  reasonPromptLine,
  reasonSecretLine,
  reasonTooLongLine,
  skippedLine,
  unknownKeyLine,
  walkHeaderLines,
  walkSummaryLines,
  walkUnreachableLine,
} from "./pilot-label-render.ts";
import type { WalkTally } from "./pilot-label-render.ts";
import { processTerminal } from "./terminal.ts";
import type { LabelTerminal } from "./terminal.ts";
import type { CliResult } from "./login.ts";

/** `crosscheck pilot <this>` reaches the walk; anything else is the report. */
export const PILOT_LABEL_SUBCOMMAND = "label";

const MINUTES_PER_HOUR = 60;

export const PILOT_LABEL_USAGE = [
  "usage: crosscheck pilot label",
  "",
  `  Walk the interventions that reached you on this repo in the last ${String(PILOT_LABEL_WINDOW_MINUTES / MINUTES_PER_HOUR)}`,
  "  hours and that you have not labelled, newest first, one key each:",
  "    h helpful · n noise · u unclear · s skip · q stop",
  "  Shift (H, N, U) adds a one-sentence reason; nothing asks for one.",
  "  A person at a terminal only — an agent cannot label for you.",
  "",
].join("\n");

const NOT_CONFIGURED = "not configured — run `crosscheck login <hubUrl>`\n";
const NOT_A_REPO = "not a git repository — labels are repo-scoped\n";

const AGENT_REFUSAL = [
  "labelling needs a person at a terminal, and this process has none.",
  "",
  "A label is the pilot's only human verdict on whether an intervention was",
  "worth it. An agent labelling the product's own interventions would be the",
  "product grading itself, so an agent may not label, even at your request.",
  "",
  "Run `crosscheck pilot label` yourself in a terminal.",
  "",
].join("\n");

/** The three label keys; Shift on one of them also asks for a reason. */
const LABEL_KEYS: ReadonlyMap<string, PilotInterventionLabel> = new Map([
  ["h", "helpful"],
  ["n", "noise"],
  ["u", "unclear"],
]);
const SKIP_KEY = "s";
const STOP_KEY = "q";

type Decision =
  | { readonly kind: "label"; readonly label: PilotInterventionLabel; readonly wantsReason: boolean }
  | { readonly kind: "skip" }
  | { readonly kind: "stop" };

type Outcome =
  | { readonly kind: "labelled"; readonly label: PilotInterventionLabel }
  | { readonly kind: "already" | "skipped" | "refused" | "stopped" | "unreachable" };

const STOP: Decision = { kind: "stop" };
const SKIP: Decision = { kind: "skip" };

/** A key is a decision, or null when it is none of the five — then the walk asks again. */
const decisionFor = (key: string | null): Decision | null => {
  const lower = key?.toLowerCase() ?? STOP_KEY;
  if (lower === STOP_KEY) {
    return STOP;
  }
  if (lower === SKIP_KEY) {
    return SKIP;
  }
  const label = LABEL_KEYS.get(lower);
  return label === undefined || key === null
    ? null
    : { kind: "label", label, wantsReason: key !== lower };
};

/** One key per prompt; a stray key is answered and asked again, never guessed. */
const readDecision = async (terminal: LabelTerminal): Promise<Decision> => {
  for (;;) {
    terminal.write(keyPromptLine());
    const decision = decisionFor(await terminal.readKey());
    if (decision !== null) {
      terminal.write(decisionEchoLine(decision.kind === "label" ? decision.label : decision.kind));
      return decision;
    }
    terminal.write(unknownKeyLine());
  }
};

/** What is wrong with a typed reason, as the sentence to print — or null when it may be sent. */
const reasonProblem = (text: string): string | null => {
  if (text.length > MAX_PILOT_LABEL_REASON_CHARS) {
    return reasonTooLongLine(text.length);
  }
  return containsSecret(text) ? reasonSecretLine() : null;
};

/** The sentence, nothing (Enter), or null when input ended before the line did. */
const readReason = async (
  terminal: LabelTerminal,
): Promise<{ readonly text: string | undefined } | null> => {
  for (;;) {
    terminal.write(reasonPromptLine());
    const line = await terminal.readLine();
    if (line === null) {
      return null;
    }
    const text = line.trim();
    const problem = text.length === 0 ? null : reasonProblem(text);
    if (problem === null) {
      return { text: text.length === 0 ? undefined : text };
    }
    terminal.write(problem);
  }
};

/** One label, sent now: an interruption after this key loses nothing already said. */
const send = async (
  ctx: HubContext,
  repo: string,
  deliveryId: string,
  label: PilotInterventionLabel,
  reason: string | undefined,
  terminal: LabelTerminal,
): Promise<Outcome> => {
  const result = await postPilotMark(ctx, {
    repo,
    refKind: "hint_delivery",
    refId: deliveryId,
    label,
    ...(reason === undefined ? {} : { reason }),
  });
  if (result.ok) {
    terminal.write(labelRecordedLine(label, reason !== undefined, result.data.repeated));
    return result.data.repeated ? { kind: "already" } : { kind: "labelled", label };
  }
  if (result.kind === "network") {
    terminal.write(walkUnreachableLine(result.message));
    return { kind: "unreachable" };
  }
  terminal.write(labelRefusedLine(result.message));
  return { kind: "refused" };
};

const labelOne = async (
  ctx: HubContext,
  repo: string,
  candidate: UnlabeledIntervention,
  terminal: LabelTerminal,
): Promise<Outcome> => {
  const decision = await readDecision(terminal);
  if (decision.kind === "stop") {
    return { kind: "stopped" };
  }
  if (decision.kind === "skip") {
    terminal.write(skippedLine());
    return { kind: "skipped" };
  }
  const reason = decision.wantsReason ? await readReason(terminal) : { text: undefined };
  return reason === null
    ? { kind: "stopped" }
    : send(ctx, repo, candidate.id, decision.label, reason.text, terminal);
};

/** The tally after one more outcome — a new object, never the old one changed. */
const counted = (tally: WalkTally, outcome: Outcome): WalkTally => {
  switch (outcome.kind) {
    case "labelled":
      return { ...tally, [outcome.label]: tally[outcome.label] + 1 };
    case "already":
      return { ...tally, already: tally.already + 1 };
    case "skipped":
      return { ...tally, skipped: tally.skipped + 1 };
    case "refused":
      return { ...tally, refused: tally.refused + 1 };
    case "stopped":
    case "unreachable":
      return tally;
  }
};

const walk = async (
  ctx: HubContext,
  repo: string,
  candidates: readonly UnlabeledIntervention[],
  terminal: LabelTerminal,
): Promise<{ readonly tally: WalkTally; readonly unreachable: boolean }> => {
  const now = ctx.now();
  let tally: WalkTally = {
    total: candidates.length,
    helpful: 0,
    noise: 0,
    unclear: 0,
    skipped: 0,
    already: 0,
    refused: 0,
    notReached: 0,
  };
  for (const [index, candidate] of candidates.entries()) {
    terminal.write(interventionLine(candidate, index, candidates.length, now));
    const outcome = await labelOne(ctx, repo, candidate, terminal);
    if (outcome.kind === "stopped" || outcome.kind === "unreachable") {
      return {
        tally: { ...tally, notReached: candidates.length - index },
        unreachable: outcome.kind === "unreachable",
      };
    }
    tally = counted(tally, outcome);
  }
  return { tally, unreachable: false };
};

const resolveHub = async (
  env: Env,
  cwd: string,
): Promise<{ readonly ctx: HubContext; readonly repo: string } | { readonly failure: CliResult }> => {
  const identity = await resolveRepoIdentity(cwd);
  const config = await loadConfig({ env, repoRoot: identity?.root });
  if (config === null) {
    return { failure: { stdout: NOT_CONFIGURED, exitCode: EXIT_OK } };
  }
  if (identity === null) {
    return { failure: { stdout: NOT_A_REPO, exitCode: EXIT_USAGE } };
  }
  return {
    repo: identity.repoId,
    ctx: {
      hubUrl: config.hubUrl,
      apiKey: config.apiKey,
      timeoutMs: config.timeoutMs,
      home: config.home,
      repoKey: repoKey(config.hubUrl, identity.repoId),
      now: () => new Date(),
    },
  };
};

export const runPilotLabel = async (
  argv: readonly string[],
  env: Env,
  cwd: string,
  isInteractive: InteractiveProbe = defaultInteractiveProbe,
  terminal: LabelTerminal = processTerminal(),
): Promise<CliResult> => {
  if (argv.length > 0) {
    return { stdout: PILOT_LABEL_USAGE, exitCode: EXIT_USAGE };
  }
  if (!isInteractive()) {
    return { stdout: AGENT_REFUSAL, exitCode: EXIT_USAGE };
  }
  const hub = await resolveHub(env, cwd);
  if ("failure" in hub) {
    return hub.failure;
  }
  const listed = await getUnlabeledInterventions(hub.ctx, {
    repo: hub.repo,
    withinMinutes: PILOT_LABEL_WINDOW_MINUTES,
  });
  if (!listed.ok) {
    return {
      stdout: markFailureLine(listed.kind, listed.message),
      exitCode: listed.kind === "network" ? EXIT_UNREACHABLE : EXIT_FAIL,
    };
  }
  const { candidates, more } = listed.data;
  if (candidates.length === 0) {
    return { stdout: nothingToLabelLine(PILOT_LABEL_WINDOW_MINUTES), exitCode: EXIT_OK };
  }
  terminal.write(walkHeaderLines(candidates.length, more, PILOT_LABEL_WINDOW_MINUTES));
  const walked = await walk(hub.ctx, hub.repo, candidates, terminal);
  return {
    stdout: walkSummaryLines(walked.tally, more),
    exitCode: walked.unreachable ? EXIT_UNREACHABLE : EXIT_OK,
  };
};
