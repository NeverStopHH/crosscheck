/**
 * `crosscheck noise [<id>]` — one word, typed beside a session that got an
 * intervention it did not need (1.0 spec 07 §3.2).
 *
 * NO TEXT, NO QUESTION, NO SURVEY (§8.3). The word is the whole message. A
 * measurement that interrupts somebody to ask how the measurement is going
 * has changed the thing it measures, so this never prompts for anything.
 *
 * WHICH DELIVERY, resolved from as little as possible:
 *   · no id — the caller's own unasked deliveries to the sessions LIVE ON THIS
 *     MACHINE for this repo, inside NOISE_MARK_WINDOW_MINUTES. Exactly one is
 *     marked; several are listed and the person names one, because a guessed
 *     mark is noise about noise.
 *   · a delivery id (`hd_…`) — marked as named.
 *   · anything else — the work context or claim id the hint PRINTED, which is
 *     the only id a person ever saw: its newest delivery to the caller.
 *
 * A PERSON AT A TERMINAL, never an agent (D3). An agent calling the product's
 * own interventions off-target would be the product grading itself, and the
 * number would measure the model's taste. The gate is the same TTY evidence
 * `crosscheck pin` uses, with the same stated limit: it is EVIDENCE, not
 * proof — a pty wrapper passes it, and the raw key can post the route — so
 * what it buys is that an agent cannot do this by accident or by default, and
 * that every mark that does arrive names the person whose key sent it.
 */
import {
  EXIT_FAIL,
  EXIT_OK,
  EXIT_UNREACHABLE,
  EXIT_USAGE,
  NOISE_MARK_WINDOW_MINUTES,
} from "@crosscheck/connector-core/constants.ts";
import { loadConfig } from "@crosscheck/connector-core/config/config.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { resolveRepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import {
  getMarkCandidates,
  postPilotMark,
} from "@crosscheck/connector-core/http/pilot.ts";
import type { HubContext, HubResult } from "@crosscheck/connector-core/http/client.ts";
import { readLiveSessionStates } from "@crosscheck/connector-core/state/session-state.ts";
import { SAFE_ID_PATTERN } from "@crosscheck/schema";
import type { PilotMarkRefKind } from "@crosscheck/schema";

import { defaultInteractiveProbe } from "./pin.ts";
import type { InteractiveProbe } from "./pin.ts";
import {
  candidateListLines,
  markFailureLine,
  markRecordedLine,
  noLiveSessionLine,
  nothingRecentLine,
  refNeverReachedLine,
} from "./pilot-mark.ts";
import type { CliResult } from "./login.ts";

export const NOISE_USAGE = [
  "usage: crosscheck noise [<id>]",
  "",
  "  One word, typed beside a session that got an intervention it did not",
  "  need: records that pointer as off-target for this repo's pilot.",
  "",
  "  With no id it finds the one that reached a live session of this repo on",
  "  this machine in the last hour, and lists them if there were several.",
  "  With an id, name the work context or claim the hint printed (wc_…,",
  "  clm_…) or a delivery id (hd_…). No text and no question — the word is",
  "  the whole message.",
  "",
].join("\n");

const NOT_CONFIGURED = "not configured — run `crosscheck login <hubUrl>`\n";
const NOT_A_REPO = "not a git repository — noise marks are repo-scoped\n";

const AGENT_REFUSAL = [
  "a noise mark needs a person at a terminal, and this process has none.",
  "",
  "The mark is the pilot's only human signal about whether an intervention was",
  "worth it. An agent calling the product's own interventions off-target would",
  "be the product grading itself, so an agent may not make one, even at your",
  "request.",
  "",
  "Run the same command yourself in a terminal.",
  "",
].join("\n");

const DELIVERY_ID_PREFIX = "hd_";

const HUB_KIND: PilotMarkRefKind = "hint_delivery";

const failed = (result: Extract<HubResult<unknown>, { ok: false }>): CliResult => ({
  stdout: markFailureLine(result.kind, result.message),
  exitCode: result.kind === "network" ? EXIT_UNREACHABLE : EXIT_FAIL,
});

const mark = async (
  ctx: HubContext,
  repo: string,
  deliveryId: string,
): Promise<CliResult> => {
  const result = await postPilotMark(ctx, {
    repo,
    refKind: HUB_KIND,
    refId: deliveryId,
  });
  if (!result.ok) {
    return failed(result);
  }
  return {
    stdout: markRecordedLine(HUB_KIND, deliveryId, result.data.repeated),
    exitCode: EXIT_OK,
  };
};

/** The ref a hint printed: its newest delivery to the caller, whenever it was. */
const markByRef = async (
  ctx: HubContext,
  repo: string,
  ref: string,
): Promise<CliResult> => {
  const found = await getMarkCandidates(ctx, { repo, ref });
  if (!found.ok) {
    return failed(found);
  }
  const [newest] = found.data.candidates;
  return newest === undefined
    ? { stdout: refNeverReachedLine(ref), exitCode: EXIT_OK }
    : mark(ctx, repo, newest.id);
};

/** No id: the one recent delivery to a session live on this machine. */
const markRecent = async (
  ctx: HubContext,
  repo: string,
): Promise<CliResult> => {
  const now = ctx.now();
  const scan = await readLiveSessionStates(ctx.home, ctx.hubUrl, repo, now);
  const sessions = scan.states.map((state) => state.crosscheckSessionId);
  if (sessions.length === 0) {
    return { stdout: noLiveSessionLine(), exitCode: EXIT_OK };
  }
  const found = await getMarkCandidates(ctx, {
    repo,
    sessions,
    withinMinutes: NOISE_MARK_WINDOW_MINUTES,
  });
  if (!found.ok) {
    return failed(found);
  }
  const { candidates, more } = found.data;
  const [only] = candidates;
  if (only === undefined) {
    return {
      stdout: nothingRecentLine(NOISE_MARK_WINDOW_MINUTES),
      exitCode: EXIT_OK,
    };
  }
  if (candidates.length > 1 || more) {
    return {
      stdout: candidateListLines(candidates, more, NOISE_MARK_WINDOW_MINUTES, now),
      exitCode: EXIT_OK,
    };
  }
  return mark(ctx, repo, only.id);
};

export const runNoise = async (
  argv: readonly string[],
  env: Env,
  cwd: string,
  isInteractive: InteractiveProbe = defaultInteractiveProbe,
): Promise<CliResult> => {
  const [id, ...extra] = argv;
  if (extra.length > 0 || (id !== undefined && !SAFE_ID_PATTERN.test(id))) {
    return { stdout: NOISE_USAGE, exitCode: EXIT_USAGE };
  }
  if (!isInteractive()) {
    return { stdout: AGENT_REFUSAL, exitCode: EXIT_USAGE };
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
  if (id === undefined) {
    return markRecent(ctx, identity.repoId);
  }
  return id.startsWith(DELIVERY_ID_PREFIX)
    ? mark(ctx, identity.repoId, id)
    : markByRef(ctx, identity.repoId, id);
};
