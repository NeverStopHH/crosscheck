/**
 * The detached summarizer worker (DESIGN.md §3 Tier 1) — the process the Stop
 * hook spawns and never waits for. The spool-flush pattern, one step earlier:
 * the shared derive only APPENDS the draft to the spool; the next hook's
 * flush ships it, and a dead hub costs nothing but disk.
 *
 * THIS FILE IS NOW ONLY THE HOST'S HALF: get the slice. Claude's slice is a
 * byte range of its own JSONL transcript (transcript.ts), re-read at exactly
 * the bounds the Stop hook gated on so a turn appended meanwhile cannot drift
 * into the fire. Everything after the text exists — spawn, gate, book, append
 * — is core/derive/summarizer/derive.ts, shared with every other connector,
 * because three workers re-deriving the gate ORDER is the drift the seam
 * exists to prevent.
 *
 * PRIVACY (§3, §10 risk 3): the transcript slice is read locally, summarized
 * locally, and thrown away. The ONLY thing that can leave is a claim that
 * survived the shared gate pipeline (core model/gates.ts).
 *
 * Fail open everywhere: every early return is silent, exit code always 0.
 */
import { EXIT_OK } from "@crosscheck/connector-core/constants.ts";
import { crosscheckHome } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { deriveFromSlice } from "@crosscheck/connector-core/derive/summarizer/derive.ts";
import { readSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { extractSliceText, readSliceRange } from "./transcript.ts";

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
  await deriveFromSlice({
    home,
    hostSessionKey: args.claudeSessionId,
    sliceText: slice,
    env,
  });
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
