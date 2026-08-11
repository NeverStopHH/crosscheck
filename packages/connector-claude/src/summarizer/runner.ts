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

/**
 * SIGKILL follow-up after the polite kill — the same escalation PATTERN as
 * git/git.ts abandonProcess (the figure is its own: 1000 ms here vs
 * GIT_KILL_GRACE_MS 500, because a model process gets more shutdown grace
 * than a local git).
 */
const KILL_GRACE_MS = 1000;

/** Race winner when the deadline beats the summarizer. */
const TIMED_OUT = Symbol("crosscheck.summarizer.timed-out");

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

interface SummarizerOutcome {
  readonly stdout: string;
  readonly exitCode: number;
}

/**
 * Signal a timed-out summarizer without waiting on it: SIGTERM now, SIGKILL
 * after KILL_GRACE_MS for a binary that ignores the first. The escalation
 * timer is unref'd so nothing is held open by it, and both kills are no-ops
 * on a process already gone — git/git.ts abandonProcess, same shape.
 */
const abandonProcess = (proc: ReturnType<typeof Bun.spawn>): void => {
  try {
    proc.kill();
  } catch {
    // Already exited.
  }
  const escalation = setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  }, KILL_GRACE_MS);
  escalation.unref();
};

/**
 * Runs the summarizer over one slice: slice on stdin, stdout captured and
 * bounded, the whole CALL bounded by `timeoutMs`. Null on ANY failure —
 * missing binary, non-zero exit, timeout — because a lost draft costs
 * nothing and a loud one costs trust (fail open, like every capture path).
 *
 * THE DEADLINE BOUNDS THE CALL, NOT THE CHILD — the runGit lesson
 * (git/git.ts), relearned here after this runner shipped without it. A
 * `claude` that is a wrapper or tee can leave a DESCENDANT holding the
 * inherited stdout pipe after the direct child exits; a read awaited past
 * the kill then pends for that descendant's whole lifetime — one stranded
 * worker process per fire, invisible to doctor. So the deadline races the
 * read: when it fires the caller gets null immediately, the child is
 * signalled without being waited on, and the abandoned read settles quietly
 * whenever the pipe finally closes. Pinned by the descendant test in
 * test/summarizer-worker.test.ts.
 */
export const runSummarizer = async (
  argv: readonly string[],
  slice: string,
  timeoutMs: number,
  env: Env,
): Promise<string | null> => {
  try {
    const proc = Bun.spawn({
      cmd: [...argv],
      stdin: Buffer.from(slice),
      stdout: "pipe",
      stderr: "ignore",
      env: { ...env },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof TIMED_OUT>((resolveDeadline) => {
      timer = setTimeout(() => {
        resolveDeadline(TIMED_OUT);
      }, timeoutMs);
    });
    const readAll: Promise<SummarizerOutcome> = (async () => {
      const stdout = await readBounded(proc.stdout, SUMMARIZER_OUTPUT_MAX_BYTES);
      const exitCode = await proc.exited;
      return { stdout, exitCode };
    })();
    // An abandoned read that later rejects must not surface as an unhandled
    // rejection; the race path below still sees the original settlement.
    readAll.catch(() => undefined);
    try {
      const outcome = await Promise.race([readAll, deadline]);
      if (outcome === TIMED_OUT) {
        abandonProcess(proc);
        return null;
      }
      return outcome.exitCode !== 0 ? null : outcome.stdout;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
};
