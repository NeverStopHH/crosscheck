/**
 * The detached ACP summarizer worker — the process the capture engine spawns
 * at a turn boundary and never waits for.
 *
 * ITS ONLY JOB IS TO READ THE SLICE OFF ITS OWN STDIN. Everything after that
 * — spawn the model, judge the answer through the shared gate order, book
 * the outcome, append the draft — is core/derive/summarizer/derive.ts, the
 * same function the Claude and Cursor workers call. Three hosts, three ways
 * to get the text, one pipeline: a second copy of the gate ORDER is the
 * drift the seam exists to prevent.
 *
 * WHY STDIN AND NOT A FILE. Claude re-reads a byte range of a transcript;
 * Cursor re-reads a byte range of whatever its transcript turns out to be.
 * Both do that because a hook process exits immediately and cannot hold a
 * pipe open for a detached child. The proxy is a long-lived parent, so the
 * slice can travel down a pipe — and the whole class of "a slice artifact
 * exists on disk for a moment" simply does not arise on this host. Nothing
 * here writes the slice anywhere either: it goes to a locally spawned
 * model's stdin and is dropped.
 *
 * Fail open everywhere: every early return is silent, exit code always 0.
 */
import { EXIT_OK } from "@crosscheck/connector-core/constants.ts";
import { SUMMARIZER_SLICE_MAX_CHARS } from "@crosscheck/connector-core/constants.ts";
import { cutWellFormed } from "@crosscheck/connector-core/briefing/cut.ts";
import { crosscheckHome } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { deriveFromSlice } from "@crosscheck/connector-core/derive/summarizer/derive.ts";
import { readSessionState } from "@crosscheck/connector-core/state/session-state.ts";

export interface AcpSummarizerArgs {
  readonly hostSessionKey: string;
}

const flagValue = (
  args: readonly string[],
  flag: string,
): string | undefined => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

export const parseAcpSummarizerArgs = (
  args: readonly string[],
): AcpSummarizerArgs | null => {
  const hostSessionKey = flagValue(args, "--session");
  return hostSessionKey === undefined ? null : { hostSessionKey };
};

/**
 * The parent already capped what it wrote (ACP_TURN_SLICE_MAX_CHARS), and
 * this cuts again on the way in. A reader that trusts its writer is one
 * refactor away from feeding an unbounded string to a model — and the cut is
 * the surrogate-safe one, so a slice never ends in half an astral character.
 */
export const readSliceFromStdin = async (): Promise<string> => {
  try {
    return cutWellFormed(await Bun.stdin.text(), SUMMARIZER_SLICE_MAX_CHARS);
  } catch {
    return "";
  }
};

const summarizeAcpTurn = async (
  args: AcpSummarizerArgs,
  env: Env,
  sliceText: string,
): Promise<void> => {
  if (sliceText.length === 0) {
    return;
  }
  const home = crosscheckHome(env);
  // A session that ended while this worker started has nothing to attribute
  // a draft to; the fire is already booked and the draft dies with it.
  const state = await readSessionState(home, args.hostSessionKey);
  if (state === null) {
    return;
  }
  await deriveFromSlice({
    home,
    hostSessionKey: args.hostSessionKey,
    sliceText,
    env,
  });
};

/** Entry point behind derive/summarizer-worker-entry.ts — always exits 0. */
export const runAcpSummarizeWorker = async (
  args: readonly string[],
  env: Env,
): Promise<number> => {
  try {
    const parsed = parseAcpSummarizerArgs(args);
    if (parsed !== null) {
      await summarizeAcpTurn(parsed, env, await readSliceFromStdin());
    }
  } catch {
    // Fail open: a lost draft is the cheap outcome.
  }
  return EXIT_OK;
};
