/**
 * The injectable summarizer runner (DESIGN.md §3 Tier 1). The DEFAULT is
 * headless `claude -p` on a Haiku-class model — the developer's existing
 * Claude Code auth, no new API key (§2 "summarizer auth") — and
 * CROSSCHECK_SUMMARIZER_CMD swaps the whole binary for an executable path,
 * which is how every test fakes it: no test depends on a real claude binary
 * or the network.
 *
 * THIS NEVER RUNS INSIDE A HOOK BUDGET. The Stop hook spawns the detached
 * worker and exits; the worker calls this, and the hard timeout here is what
 * keeps a hung binary from accumulating — a kill, not a wait.
 */
import {
  SUMMARIZER_MODEL,
  SUMMARIZER_OUTPUT_MAX_BYTES,
  SUMMARIZER_TIMEOUT_MS,
} from "../constants.ts";
import type { Env } from "../config/paths.ts";

/**
 * What the model is asked, verbatim. One assertion or NONE — the tolerant
 * parse (parse.ts) discards everything else, so the prompt and the parser
 * agree on the contract.
 */
export const SUMMARIZER_PROMPT =
  "You are a passive capture assistant for a team knowledge tool. Below is a " +
  "slice of one coding-session turn. If it contains ONE concrete diagnostic " +
  "finding about a bug or failure, answer with ONLY a JSON object of the form " +
  '{"kind": "<observation|hypothesis|evidence|root_cause|decision|rejected_approach>", ' +
  '"body": "<the finding as one sentence, max 400 characters>", ' +
  '"confidence": <a number between 0 and 0.5>} and nothing else. ' +
  "The body must state the finding itself, not narrate the session. " +
  "If there is no clear diagnostic finding, answer with exactly NONE.";

/** SIGKILL follow-up after the polite kill, mirroring GIT_KILL_GRACE_MS. */
const KILL_GRACE_MS = 1000;

/**
 * The argv to spawn: the override executable alone, or headless claude. The
 * override replaces the binary WHOLESALE (no argument splicing — an operator
 * or test owns the whole contract: slice on stdin, output on stdout).
 */
export const resolveSummarizerArgv = (env: Env): readonly string[] => {
  const override = env["CROSSCHECK_SUMMARIZER_CMD"];
  if (override !== undefined && override.length > 0) {
    return [override];
  }
  return ["claude", "-p", SUMMARIZER_PROMPT, "--model", SUMMARIZER_MODEL];
};

const parsePositiveInt = (raw: string | undefined): number | null => {
  if (raw === undefined) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

/** Hard timeout, env-overridable (tests, slow machines) but never unbounded. */
export const resolveSummarizerTimeoutMs = (env: Env): number =>
  parsePositiveInt(env["CROSSCHECK_SUMMARIZER_TIMEOUT_MS"]) ??
  SUMMARIZER_TIMEOUT_MS;

/** Bounded stdout read: past the cap the stream is cancelled, not buffered. */
const readBounded = async (
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<string> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString().slice(0, maxBytes);
};

/**
 * Runs the summarizer over one slice: slice on stdin, stdout captured and
 * bounded, the process killed hard at `timeoutMs`. Null on ANY failure —
 * missing binary, non-zero exit, timeout — because a lost draft costs
 * nothing and a loud one costs trust (fail open, like every capture path).
 */
export const runSummarizer = async (
  argv: readonly string[],
  slice: string,
  timeoutMs: number,
  env: Env,
): Promise<string | null> => {
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = Bun.spawn({
      cmd: [...argv],
      stdin: Buffer.from(slice),
      stdout: "pipe",
      stderr: "ignore",
      env: { ...env },
    });
    let timedOut = false;
    killTimer = setTimeout(() => {
      timedOut = true;
      proc.kill();
      // A binary that ignores SIGTERM still dies; nothing waits on this.
      graceTimer = setTimeout(() => proc.kill(9), KILL_GRACE_MS);
    }, timeoutMs);
    const stdout = await readBounded(proc.stdout, SUMMARIZER_OUTPUT_MAX_BYTES);
    const exitCode = await proc.exited;
    return timedOut || exitCode !== 0 ? null : stdout;
  } catch {
    return null;
  } finally {
    clearTimeout(killTimer);
    clearTimeout(graceTimer);
  }
};
