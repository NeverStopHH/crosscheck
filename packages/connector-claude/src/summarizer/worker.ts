/**
 * The detached summarizer worker (DESIGN.md §3 Tier 1) — the process the Stop
 * hook spawns and never waits for. The spool-flush pattern, one step earlier:
 * this worker only APPENDS the draft to the spool; the next hook's flush
 * ships it, and a dead hub costs nothing but disk.
 *
 * PRIVACY IS THE SHAPE OF THIS FILE (§3, §10 risk 3): the transcript slice is
 * read locally, summarized locally, and thrown away. The ONLY thing that can
 * leave this function is a claim that survived, in order: tolerant parse,
 * echo-loop exclusion, secret scan, and the shared wire contract's checkClaim
 * — the same validator the MCP publish path and the hub apply, reused rather
 * than duplicated, derived-confidence cap included.
 *
 * Fail open everywhere: every early return is silent, exit code always 0.
 */
import { DEFAULT_AGENT_KIND, EXIT_OK } from "@crosscheck/connector-core/constants.ts";
import { crosscheckHome, repoKey } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { buildEnvelope, UNKNOWN_DEVELOPER_ID } from "@crosscheck/connector-core/capture/records.ts";
import { containsSecret } from "@crosscheck/connector-core/capture/secret-scan.ts";
import { readDeliveredHintHashes } from "@crosscheck/connector-core/hints/delivered-store.ts";
import { isEchoOfDeliveredHint } from "@crosscheck/connector-core/hints/echo.ts";
import { checkClaim } from "@crosscheck/connector-core/mcp/violations.ts";
import { mintClaimId } from "@crosscheck/connector-core/mcp/tools/shared.ts";
import { appendRecords } from "@crosscheck/connector-core/spool/append.ts";
import {
  readSessionState,
  updateSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import {
  withSummarizerDraft,
  withSummarizerFailure,
  withSummarizerNone,
  withSummarizerRejection,
} from "./gate.ts";
import { isNoneAnswer, parseSummarizerOutput } from "@crosscheck/connector-core/model/parse.ts";
import {
  isPromptEcho,
  isRolePlayAnswer,
  REJECTED_CONTRACT,
  REJECTED_HINT_ECHO,
  REJECTED_PROMPT_ECHO,
  REJECTED_ROLE_PLAY,
  REJECTED_SECRET,
} from "@crosscheck/connector-core/model/reject.ts";
import {
  formatSummarizerFailure,
  resolveSummarizerArgv,
  resolveSummarizerTimeoutMs,
  runSummarizer,
  SUMMARIZER_PROMPT,
} from "@crosscheck/connector-core/model/runner.ts";
import { extractSliceText, readSliceRange } from "./transcript.ts";
import { ensureSummarizerCwd } from "@crosscheck/connector-core/model/worker-env.ts";

interface WorkerArgs {
  readonly transcriptPath: string;
  readonly claudeSessionId: string;
  readonly sliceStart: number;
  readonly sliceEnd: number;
}

const flagValue = (
  args: readonly string[],
  flag: string,
): string | undefined => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

export const parseWorkerArgs = (
  args: readonly string[],
): WorkerArgs | null => {
  const transcriptPath = flagValue(args, "--transcript");
  const claudeSessionId = flagValue(args, "--session");
  const sliceStart = Number(flagValue(args, "--slice-start"));
  const sliceEnd = Number(flagValue(args, "--slice-end"));
  if (
    transcriptPath === undefined ||
    claudeSessionId === undefined ||
    !Number.isSafeInteger(sliceStart) ||
    !Number.isSafeInteger(sliceEnd)
  ) {
    return null;
  }
  return { transcriptPath, claudeSessionId, sliceStart, sliceEnd };
};

const summarizeTurn = async (args: WorkerArgs, env: Env): Promise<void> => {
  const home = crosscheckHome(env);
  const state = await readSessionState(home, args.claudeSessionId);
  if (state === null) {
    return;
  }
  const raw = await readSliceRange(
    args.transcriptPath,
    args.sliceStart,
    args.sliceEnd,
  );
  if (raw === null) {
    return;
  }
  const slice = extractSliceText(raw);
  if (slice.length === 0) {
    return;
  }

  const result = await runSummarizer(
    resolveSummarizerArgv(env),
    slice,
    resolveSummarizerTimeoutMs(env),
    env,
    // From the neutral directory, never the repo root the hook fired in
    // (trial finding #14: no project CLAUDE.md rides into the fire).
    { cwd: await ensureSummarizerCwd(home) },
  );
  if (!result.ok) {
    // Failure telemetry (trial finding #14): the runner's own losses —
    // missing binary, non-zero exit, deadline — are booked with their
    // reason (exit code / timeout / the first STDOUT line, sanitized and
    // bounded; stderr is never read), so the fires-minus-outcomes
    // remainder is no longer a number nobody can explain.
    await updateSessionState(home, args.claudeSessionId, (fresh) =>
      withSummarizerFailure(fresh, formatSummarizerFailure(result)),
    );
    return;
  }
  const stdout = result.stdout;
  const draft = parseSummarizerOutput(stdout);
  if (draft === null) {
    // Outcome telemetry (trial finding #12's measuring stick): only an
    // EXPLICIT NONE is booked — unparseable garbage is a runner problem,
    // and stays visible as the fires-minus-outcomes remainder instead.
    if (isNoneAnswer(stdout)) {
      await updateSessionState(home, args.claudeSessionId, withSummarizerNone);
    }
    return;
  }

  // Every refusal below is BOOKED (audit rows M16 / A3-4): each was a silent
  // `return`, so a fire whose well-formed answer nobody kept looked exactly
  // like a runner that never spoke — and the quota was spent either way.
  const reject = async (reason: string): Promise<void> => {
    await updateSessionState(home, args.claudeSessionId, (fresh) =>
      withSummarizerRejection(fresh, reason),
    );
  };

  // ROLE-PLAY, before anything else: the model answered as the agent whose
  // turn it read and narrated the next step, which the prompt already says is
  // not a conclusion. It is the shape a tail-degraded slice produces most.
  if (isRolePlayAnswer(draft.body)) {
    await reject(REJECTED_ROLE_PLAY);
    return;
  }
  // The instructions, handed back on schema.
  if (isPromptEcho(draft.body, SUMMARIZER_PROMPT)) {
    await reject(REJECTED_PROMPT_ECHO);
    return;
  }

  // FRESH state for the exclusions: hints may have been delivered while the
  // model ran, and a session that ended meanwhile has nothing to attribute
  // to — its state file is gone and the draft dies with it (honest).
  const fresh = await readSessionState(home, args.claudeSessionId);
  if (fresh === null) {
    return;
  }
  // Echo-loop exclusion (§3, judge-mandated, no session qualifier): a body a
  // teammate hint delivered — this session (state) OR any earlier one in this
  // repo (the per-repo store) — must never come back as this session's own
  // independent observation.
  const persistedHashes = await readDeliveredHintHashes(
    home,
    repoKey(fresh.hubUrl, fresh.repoId),
  );
  const deliveredHashes = [...fresh.deliveredHintHashes, ...persistedHashes];
  if (isEchoOfDeliveredHint(draft.body, deliveredHashes)) {
    await reject(REJECTED_HINT_ECHO);
    return;
  }
  // Secret scan before anything can leave the machine: a hit DROPS the
  // draft, never redacts it (capture/secret-scan.ts states why).
  if (containsSecret(draft.body)) {
    // Booked WITHOUT the match, like every other secret refusal in this
    // product: the count says a drop happened, the reason says which class,
    // and neither says what was in it.
    await reject(REJECTED_SECRET);
    return;
  }

  const now = new Date();
  const claim = {
    id: mintClaimId(),
    workContextId: fresh.workContextId,
    authorSessionId: fresh.crosscheckSessionId,
    kind: draft.kind,
    body: draft.body,
    // Draft semantics, non-negotiable (§3 Tier 1): the model chose kind and
    // body; everything that carries TRUST is forced here.
    status: "proposed",
    confidence: draft.confidence,
    captureMode: "auto",
    provenance: "derived",
    evidenceRefs: [],
    createdAt: now.toISOString(),
  };
  // The shared wire contract, reused not duplicated: ClaimSchema behind
  // checkClaim enforces the derived-confidence cap the same way the hub does.
  if (!checkClaim(claim).ok) {
    await reject(REJECTED_CONTRACT);
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
  // Booked AFTER the spool append: "draft produced" means the draft exists
  // on disk, not that the model merely offered one (telemetry honesty).
  await updateSessionState(home, args.claudeSessionId, withSummarizerDraft);
};

/** Entry point behind `crosscheck summarize-turn` — always exits 0. */
export const runSummarizeWorker = async (
  args: readonly string[],
  env: Env,
): Promise<number> => {
  try {
    const parsed = parseWorkerArgs(args);
    if (parsed !== null) {
      await summarizeTurn(parsed, env);
    }
  } catch {
    // Fail open: a lost draft is the cheap outcome.
  }
  return EXIT_OK;
};
