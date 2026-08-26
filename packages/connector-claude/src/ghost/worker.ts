/**
 * The detached ghost-check worker (VISION.md §3) — the derived-intent
 * worker's shape (intent/worker.ts), one tier up: it compares THIS session's
 * plan with the one teammate whose live plan overlaps it, and appends the
 * model's single sentence as a DRAFT the author reviews.
 *
 * IT IS GATED, and the gate is the deterministic core. The worker asks the
 * hub who overlaps before it spends anything; a repo with nobody in the same
 * files, on the same failure or on the same topic books `noOverlap` and
 * exits, having cost one bounded GET and no tokens at all. That is the
 * feature's stated bargain: the free half runs always, the paid half only
 * when the free half found somebody.
 *
 * WHAT LEAVES THIS MACHINE. Nothing new. The model reads two intent sentences
 * and the teammate's DECLARED claims (ghost/prompt.ts says why those and
 * nothing else), all of which the hub already holds and would hand this same
 * caller through `get_diagnosis`. No prompt file is parked on disk on this
 * path — the input is built in memory and written to the child's stdin — so
 * this worker adds nothing to the orphaned-file surface the intent path has.
 *
 * WHAT MAY COME BACK. One sentence, and only after, in order: the NONE parse,
 * the bound, the ECHO EXCLUSION AGAINST WHAT IT WAS JUST SHOWN (a paraphrase
 * of the teammate's own claim must not come back as this session's derived
 * observation — the summarizer's echo rule, pointed at this call's own
 * input), the delivered-hint echo exclusion, the secret scan, and the shared
 * claim contract with its derived-confidence cap. The result is
 * `provenance: derived`, `status: proposed`, `captureMode: auto`,
 * confidence GHOST_DERIVED_CONFIDENCE — a Tier-1 draft, shown to its author
 * with `review_draft` and to nobody else.
 *
 * Fail open everywhere: every early return is silent, exit code always 0.
 */
import {
  DEFAULT_AGENT_KIND,
  EXIT_OK,
  GHOST_DERIVED_CONFIDENCE,
  GHOST_SENTENCE_MAX_CHARS,
} from "@crosscheck/connector-core/constants.ts";
import { cutWellFormed } from "@crosscheck/connector-core/briefing/cut.ts";
import { loadReportableConfig } from "@crosscheck/connector-core/config/config.ts";
import { crosscheckHome, repoKey } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import {
  buildEnvelope,
  UNKNOWN_DEVELOPER_ID,
} from "@crosscheck/connector-core/capture/records.ts";
import { containsSecret } from "@crosscheck/connector-core/capture/secret-scan.ts";
import { readDeliveredHintHashes } from "@crosscheck/connector-core/hints/delivered-store.ts";
import { hintBodyHash, isEchoOfDeliveredHint } from "@crosscheck/connector-core/hints/echo.ts";
import { getDiagnosis, getGhostChecks } from "@crosscheck/connector-core/http/hub.ts";
import type { GhostCheckEntry, HubContext } from "@crosscheck/connector-core/http/hub.ts";
import { checkClaim } from "@crosscheck/connector-core/mcp/violations.ts";
import { mintClaimId } from "@crosscheck/connector-core/mcp/tools/shared.ts";
import { appendRecords } from "@crosscheck/connector-core/spool/append.ts";
import {
  readSessionState,
  updateSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import type { SessionState } from "@crosscheck/connector-core/state/session-state.ts";
import {
  hasGhostAllowance,
  withGhostDraft,
  withGhostFailure,
  withGhostFire,
  withGhostNone,
  withGhostNoOverlap,
} from "./gate.ts";
import { declaredClaimLines, renderGhostInput, resolveGhostArgv } from "./prompt.ts";
import { isNoneAnswer } from "../summarizer/parse.ts";
import {
  formatSummarizerFailure,
  resolveSummarizerTimeoutMs,
  runSummarizer,
} from "../summarizer/runner.ts";
import { ensureSummarizerCwd } from "../summarizer/worker-env.ts";

export interface GhostWorkerArgs {
  readonly claudeSessionId: string;
}

const flagValue = (args: readonly string[], flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

export const parseGhostWorkerArgs = (
  args: readonly string[],
): GhostWorkerArgs | null => {
  const claudeSessionId = flagValue(args, "--session");
  return claudeSessionId === undefined ? null : { claudeSessionId };
};

/** Booked drops, named so status/doctor can say why a fire landed nothing. */
const DROPPED_NO_HUB_ANSWER = "dropped: the hub did not answer the overlap query";
const DROPPED_EMPTY_ANSWER = "dropped: empty answer";
const DROPPED_INPUT_ECHO = "dropped: the sentence repeats a claim it was shown";
const DROPPED_HINT_ECHO = "dropped: the sentence echoes a delivered hint";
const DROPPED_SECRET = "dropped: secret-like text";
const DROPPED_CONTRACT = "dropped: the claim failed the wire contract";

const bookFailure = (
  home: string,
  sessionId: string,
  detail: string,
): Promise<boolean> =>
  updateSessionState(home, sessionId, (fresh) => withGhostFailure(fresh, detail));

/** The first non-empty line of what the model said, whitespace-collapsed. */
const firstSentence = (stdout: string): string =>
  stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0)
    ?.replace(/\s+/g, " ") ?? "";

/**
 * The hub context, resolved through the SAME loader every reporting surface
 * uses (`loadReportableConfig`) rather than assembled from environment
 * variables here: it is what applies the per-repo `.crosscheck.json` gate, the
 * stored api key and the measured timeout. Null when this repo is not
 * connected — a session whose repo was disconnected mid-flight simply has no
 * hub to ask, which is silence rather than a booked failure.
 *
 * The state's OWN hubUrl still has to match: a worker spawned for a session
 * bound to one hub must never ask a different one about that session's plan
 * (the first-wins rule finding #9 wrote into every repo-scoped path).
 */
const hubFor = async (
  state: SessionState,
  env: Env,
): Promise<HubContext | null> => {
  const config = await loadReportableConfig({ env, repoRoot: state.repoRoot });
  if (config === null || config.hubUrl !== state.hubUrl) {
    return null;
  }
  return {
    hubUrl: config.hubUrl,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    home: config.home,
    repoKey: repoKey(config.hubUrl, state.repoId),
    now: () => new Date(),
  };
};

/** The teammate's stated sentence, or "" — the wire intent is tolerant. */
const intentSummaryOf = (entry: GhostCheckEntry): string => {
  const intent = entry.intent;
  return intent === null || intent === undefined ? "" : intent.summary;
};

const runGhostCheck = async (
  args: GhostWorkerArgs,
  env: Env,
): Promise<void> => {
  const home = crosscheckHome(env);
  const state = await readSessionState(home, args.claudeSessionId);
  if (state === null || state.workContextIntent === null) {
    // No plan of my own to compare: nothing was owed after all, and there is
    // nothing to book — the debt is already spent by the caller that spawned
    // this worker.
    return;
  }
  if (!hasGhostAllowance(state)) {
    return;
  }
  const hub = await hubFor(state, env);
  if (hub === null) {
    return;
  }
  const overlaps = await getGhostChecks(hub, state.repoId);
  if (!overlaps.ok) {
    await bookFailure(home, args.claudeSessionId, DROPPED_NO_HUB_ANSWER);
    return;
  }
  const candidate = overlaps.data[0];
  if (candidate === undefined) {
    // THE GATE, and the reason this feature costs a quiet repo nothing.
    await updateSessionState(home, args.claudeSessionId, withGhostNoOverlap);
    return;
  }
  // Record-then-spawn under the lock: a crash between the two costs one
  // unspent fire, never a second model call.
  let fired = false;
  await updateSessionState(home, args.claudeSessionId, (fresh) => {
    if (!hasGhostAllowance(fresh)) {
      return null;
    }
    fired = true;
    return withGhostFire(fresh);
  });
  if (!fired) {
    return;
  }
  // Their declared claims are CONTEXT, not a requirement: a tree with none,
  // or a diagnosis read that fails, still leaves two intents to compare.
  const tree = await getDiagnosis(hub, candidate.workContextId);
  const claimLines = tree.ok ? declaredClaimLines(tree.data.claims) : [];
  const input = renderGhostInput({
    ownIntent: state.workContextIntent,
    theirIntent: intentSummaryOf(candidate),
    theirClaims: claimLines,
  });
  const result = await runSummarizer(
    resolveGhostArgv(env),
    input,
    resolveSummarizerTimeoutMs(env),
    env,
    // From the neutral directory, never the repo root (trial finding #14).
    { cwd: await ensureSummarizerCwd(home) },
  );
  if (!result.ok) {
    await bookFailure(home, args.claudeSessionId, formatSummarizerFailure(result));
    return;
  }
  if (isNoneAnswer(result.stdout)) {
    await updateSessionState(home, args.claudeSessionId, withGhostNone);
    return;
  }
  const sentence = cutWellFormed(
    firstSentence(result.stdout),
    GHOST_SENTENCE_MAX_CHARS,
  );
  if (sentence.length === 0) {
    await bookFailure(home, args.claudeSessionId, DROPPED_EMPTY_ANSWER);
    return;
  }
  await appendGhostDraft(home, args, sentence, claimLines, env);
};

/**
 * The gates, then the spool. THE FIRST ONE IS NEW and is this surface's own:
 * a sentence that merely restates a claim the model was just shown would
 * publish a teammate's finding back as this session's derived observation,
 * under a fresh id and a fresh timestamp — provenance laundering by
 * paraphrase, which is exactly what the echo-loop rule exists to stop. The
 * hash is the delivered-hint hash (normalised the way the hub normalises a
 * body for dedup), so "the same words" means the same thing on both sides.
 */
const appendGhostDraft = async (
  home: string,
  args: GhostWorkerArgs,
  sentence: string,
  shownClaimLines: readonly string[],
  env: Env,
): Promise<void> => {
  const shownHashes = shownClaimLines.map((line) => hintBodyHash(line));
  if (isEchoOfDeliveredHint(sentence, shownHashes)) {
    await bookFailure(home, args.claudeSessionId, DROPPED_INPUT_ECHO);
    return;
  }
  // FRESH state for the rest: hints may have been delivered while the model
  // ran, and a session that ended meanwhile has nothing to attribute to.
  const fresh = await readSessionState(home, args.claudeSessionId);
  if (fresh === null) {
    return;
  }
  const persistedHashes = await readDeliveredHintHashes(
    home,
    repoKey(fresh.hubUrl, fresh.repoId),
  );
  if (
    isEchoOfDeliveredHint(sentence, [
      ...fresh.deliveredHintHashes,
      ...persistedHashes,
    ])
  ) {
    await bookFailure(home, args.claudeSessionId, DROPPED_HINT_ECHO);
    return;
  }
  if (containsSecret(sentence)) {
    await bookFailure(home, args.claudeSessionId, DROPPED_SECRET);
    return;
  }
  const now = new Date();
  const claim = {
    id: mintClaimId(),
    workContextId: fresh.workContextId,
    authorSessionId: fresh.crosscheckSessionId,
    // A collision the model INFERRED is a hypothesis, never an observation:
    // nobody has seen the two changes meet, and the kind is what a reader
    // weighs the sentence by.
    kind: "hypothesis",
    body: sentence,
    status: "proposed",
    confidence: GHOST_DERIVED_CONFIDENCE,
    captureMode: "auto",
    provenance: "derived",
    evidenceRefs: [],
    createdAt: now.toISOString(),
  };
  // The shared wire contract, reused not duplicated: what the hub would
  // refuse never enters the spool, derived-confidence cap included.
  if (!checkClaim(claim).ok) {
    await bookFailure(home, args.claudeSessionId, DROPPED_CONTRACT);
    return;
  }
  await appendRecords(
    home,
    repoKey(fresh.hubUrl, fresh.repoId),
    args.claudeSessionId,
    [
      buildEnvelope(
        "claim",
        claim,
        {
          developerId: fresh.developerId ?? UNKNOWN_DEVELOPER_ID,
          agentKind: env["CROSSCHECK_AGENT_KIND"] ?? DEFAULT_AGENT_KIND,
          sessionId: fresh.crosscheckSessionId,
        },
        now,
      ),
    ],
    now,
  );
  // Booked AFTER the spool append: "drafted" means the draft exists on disk,
  // not that the model merely offered a sentence (telemetry honesty).
  await updateSessionState(home, args.claudeSessionId, withGhostDraft);
};

/** Entry point behind ghost/worker-entry.ts — always exits 0. */
export const runGhostWorker = async (
  args: readonly string[],
  env: Env,
): Promise<number> => {
  try {
    const parsed = parseGhostWorkerArgs(args);
    if (parsed !== null) {
      await runGhostCheck(parsed, env);
    }
  } catch {
    // Fail open: a lost ghost check is the cheap outcome.
  }
  return EXIT_OK;
};
