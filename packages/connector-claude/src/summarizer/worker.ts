/**
 * The detached summarizer worker (DESIGN.md §3 Tier 1) — the process the Stop
 * hook spawns and never waits for. The spool-flush pattern, one step earlier:
 * this worker only APPENDS the draft to the spool; the next hook's flush
 * ships it, and a dead hub costs nothing but disk.
 *
 * PRIVACY IS THE SHAPE OF THIS FILE (§3, §10 risk 3): the transcript slice is
 * read locally, summarized locally, and thrown away. The ONLY thing that can
 * leave this function is a claim that survived the shared gate pipeline —
 * core model/gates.ts, whose header states the order it runs and which every
 * connector's worker now calls instead of re-deriving it. This file keeps
 * exactly the two jobs a HOST owns: getting the slice (transcript.ts) and
 * booking the outcome in this connector's session state.
 *
 * Fail open everywhere: every early return is silent, exit code always 0.
 */
import { DEFAULT_AGENT_KIND, EXIT_OK } from "@crosscheck/connector-core/constants.ts";
import { crosscheckHome, repoKey } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { buildEnvelope, UNKNOWN_DEVELOPER_ID } from "@crosscheck/connector-core/capture/records.ts";
import { readDeliveredHintHashes } from "@crosscheck/connector-core/hints/delivered-store.ts";
import { appendRecords } from "@crosscheck/connector-core/spool/append.ts";
import {
  readSessionState,
  updateSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import type { SessionState } from "@crosscheck/connector-core/state/session-state.ts";
import {
  withSummarizerDraft,
  withSummarizerFailure,
  withSummarizerNone,
  withSummarizerRejection,
} from "./gate.ts";
import { gateModelAnswer } from "@crosscheck/connector-core/model/gates.ts";
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
  // FRESH state for the gates that need session facts, resolved by the
  // pipeline itself so the read stays exactly where it was: hints may have
  // been delivered while the model ran, and a session that ended meanwhile
  // has nothing to attribute to — its state file is gone and the draft dies
  // with it (honest). Held in a box so the outcome branches below can still
  // see what the callback read.
  const held: { current: SessionState | null } = { current: null };
  const now = new Date();
  const outcome = await gateModelAnswer({
    stdout: result.stdout,
    prompt: SUMMARIZER_PROMPT,
    now,
    resolveContext: async () => {
      const fresh = await readSessionState(home, args.claudeSessionId);
      if (fresh === null) {
        return null;
      }
      held.current = fresh;
      // The echo-loop exclusion's inputs (§3, judge-mandated, no session
      // qualifier): a body a teammate hint delivered — this session (state)
      // OR any earlier one in this repo (the per-repo store).
      const persistedHashes = await readDeliveredHintHashes(
        home,
        repoKey(fresh.hubUrl, fresh.repoId),
      );
      return {
        workContextId: fresh.workContextId,
        authorSessionId: fresh.crosscheckSessionId,
        deliveredHintHashes: [
          ...fresh.deliveredHintHashes,
          ...persistedHashes,
        ],
      };
    },
  });

  // Outcome telemetry (trial finding #12's measuring stick): only an EXPLICIT
  // NONE is booked — unparseable garbage is a runner problem, and stays
  // visible as the fires-minus-outcomes remainder instead. `abandoned` is the
  // ended session, which has no state file left to book anything in.
  if (outcome.kind === "unparseable" || outcome.kind === "abandoned") {
    return;
  }
  if (outcome.kind === "none") {
    await updateSessionState(home, args.claudeSessionId, withSummarizerNone);
    return;
  }
  // Every refusal is BOOKED (audit rows M16 / A3-4): each was a silent
  // `return`, so a fire whose well-formed answer nobody kept looked exactly
  // like a runner that never spoke — and the quota was spent either way.
  if (outcome.kind === "rejected") {
    const reason = outcome.reason;
    await updateSessionState(home, args.claudeSessionId, (fresh) =>
      withSummarizerRejection(fresh, reason),
    );
    return;
  }

  const attribution = held.current;
  if (attribution === null) {
    return;
  }
  await appendRecords(
    home,
    repoKey(attribution.hubUrl, attribution.repoId),
    args.claudeSessionId,
    [
      buildEnvelope(
        "claim",
        outcome.claim,
        {
          developerId: attribution.developerId ?? UNKNOWN_DEVELOPER_ID,
          agentKind: env["CROSSCHECK_AGENT_KIND"] ?? DEFAULT_AGENT_KIND,
          sessionId: attribution.crosscheckSessionId,
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
