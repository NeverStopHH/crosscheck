/**
 * The detached Cursor summarizer worker — the process the `stop` handler
 * spawns and never waits for.
 *
 * ITS ONLY JOB IS THE SLICE. Cursor's half of Tier-1 is "re-read exactly the
 * transcript bytes the stop handler gated on, decode them"; everything after
 * that — spawn the model, judge the answer through the shared gate order,
 * book the outcome, append the draft — is
 * core/derive/summarizer/derive.ts, the same function the Claude worker
 * calls. Two hosts, two readers, one pipeline: a second copy of the gate
 * ORDER is the drift the seam exists to prevent.
 *
 * A slice that no longer decodes here is a silent return and nothing else:
 * the stop handler already booked the fire it decided on, and the
 * no-slice outcome belongs to the handler that could still see the turn.
 *
 * Fail open everywhere: every early return is silent, exit code always 0.
 */
import { EXIT_OK } from "@crosscheck/connector-core/constants.ts";
import { crosscheckHome } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { deriveFromSlice } from "@crosscheck/connector-core/derive/summarizer/derive.ts";
import { readSessionState } from "@crosscheck/connector-core/state/session-state.ts";

import {
  extractCursorSliceText,
  readCursorSliceRange,
} from "./transcript.ts";

export interface CursorSummarizerArgs {
  readonly hostSessionKey: string;
  readonly transcriptPath: string;
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

export const parseCursorSummarizerArgs = (
  args: readonly string[],
): CursorSummarizerArgs | null => {
  const hostSessionKey = flagValue(args, "--session");
  const transcriptPath = flagValue(args, "--transcript");
  const sliceStart = Number(flagValue(args, "--slice-start"));
  const sliceEnd = Number(flagValue(args, "--slice-end"));
  if (
    hostSessionKey === undefined ||
    transcriptPath === undefined ||
    !Number.isSafeInteger(sliceStart) ||
    !Number.isSafeInteger(sliceEnd)
  ) {
    return null;
  }
  return { hostSessionKey, transcriptPath, sliceStart, sliceEnd };
};

const summarizeCursorTurn = async (
  args: CursorSummarizerArgs,
  env: Env,
): Promise<void> => {
  const home = crosscheckHome(env);
  const state = await readSessionState(home, args.hostSessionKey);
  if (state === null) {
    return;
  }
  const raw = await readCursorSliceRange(
    args.transcriptPath,
    args.sliceStart,
    args.sliceEnd,
  );
  if (raw === null) {
    return;
  }
  const slice = extractCursorSliceText(raw);
  if (slice === null || slice.text.length === 0) {
    return;
  }
  await deriveFromSlice({
    home,
    hostSessionKey: args.hostSessionKey,
    sliceText: slice.text,
    env,
  });
};

/** Entry point behind derive/summarizer-worker-entry.ts — always exits 0. */
export const runCursorSummarizeWorker = async (
  args: readonly string[],
  env: Env,
): Promise<number> => {
  try {
    const parsed = parseCursorSummarizerArgs(args);
    if (parsed !== null) {
      await summarizeCursorTurn(parsed, env);
    }
  } catch {
    // Fail open: a lost draft is the cheap outcome.
  }
  return EXIT_OK;
};
