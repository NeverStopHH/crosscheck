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
 *
 * THE NESTED CLAUDE IS A MODEL CALL, NOT A SESSION (trial finding #14). A
 * plain `claude -p` loads the developer's whole settings stack — ~10 MCP
 * servers, plugins, hooks — which took 35–116 s on a trivial slice (four
 * runs, 2026-08-21) against the then-30 s deadline, and ran crosscheck's own
 * globally installed hooks from inside the summarizer (phantom sessions,
 * and a Stop hook that could fire the summarizer again). SUMMARIZER_LEAN_FLAGS
 * below strip all of that; the marker env (SUMMARIZER_CHILD_ENV) is the
 * guard that holds even where a flag does not.
 */
import { bareUntrusted } from "@crosscheck/connector-core/briefing/sanitize.ts";
import {
  SUMMARIZER_CHILD_ENV,
  SUMMARIZER_CHILD_ON,
  SUMMARIZER_FAILURE_MAX_CHARS,
  SUMMARIZER_MODEL,
  SUMMARIZER_OUTPUT_MAX_BYTES,
  SUMMARIZER_TIMEOUT_MS,
} from "@crosscheck/connector-core/constants.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";

/**
 * What the model is asked, verbatim. One assertion or NONE — the tolerant
 * parse (parse.ts) discards everything else, so the prompt and the parser
 * agree on the contract.
 *
 * WIDENED for conclusion moments (trial finding #12): the prompt asks for
 * any conclusion a TEAMMATE in the same area would act on — diagnosis,
 * decision, ruled-out approach, review finding — with the same strictness
 * as before. Progress narration, plans and praise are named out explicitly,
 * and NONE stays the right answer for chatter. The precision instrument for
 * this wording is the conclusion corpus
 * (test/fixtures/conclusion-corpus/format.ts): its distillations define
 * what a correct answer looks like per slice shape, and
 * test/conclusion-corpus.test.ts pins the defining words of this contract.
 */
export const SUMMARIZER_PROMPT =
  "You are a passive capture assistant for a team knowledge tool. Below is a " +
  "slice of one coding-session turn. If it contains ONE concrete conclusion " +
  "a teammate working in the same area would act on — a diagnostic finding " +
  "about a bug or failure, a decision reached and its reason, an approach " +
  "ruled out and why, or what a review found — answer with ONLY a JSON " +
  "object of the form " +
  '{"kind": "<observation|hypothesis|evidence|root_cause|decision|rejected_approach>", ' +
  '"body": "<the conclusion as one sentence, max 400 characters>", ' +
  '"confidence": <a number between 0 and 0.5>} and nothing else. ' +
  "The body must state the conclusion itself — what was decided, found or " +
  "ruled out, and why — and never narrate the session. Progress reports " +
  '("tests pass now", "implemented X"), plans, and praise are not ' +
  "conclusions. If there is no such conclusion, answer with exactly NONE.";

/**
 * The flags that make the nested `claude -p` a bare model call (trial
 * finding #14), each measured on Claude Code 2.1.237 from a connected repo
 * cwd with USER forwarded — plain run 72 s and 3 phantom session files;
 * with every flag below 9 s, 0 session files, 0 transcripts:
 *
 *   --setting-sources ""         load NO user/project/local settings: no
 *                                hooks, no plugins, no MCP servers from
 *                                ~/.claude.json (the whole cold start)
 *   --strict-mcp-config          only MCP servers from --mcp-config …
 *   --mcp-config {"mcpServers":{}}  … of which there are none
 *   --no-session-persistence     no ~/.claude/projects transcript per fire
 *   --tools ""                   no tools: the model can only answer
 *   --max-turns 1                one answer, never an agentic loop
 *
 * `--bare` was REJECTED: it skips keychain/OAuth auth (Claude Code's own
 * help: requires ANTHROPIC_API_KEY or an apiKeyHelper), so every developer
 * logged in through `claude /login` would read "Not logged in". Every flag
 * here is ACCEPTED by 2.1.237; all but --max-turns are listed by
 * `claude --help` (--max-turns is a print-mode flag the help omits — the
 * zero-cost check is `claude --max-turns 1 --bogus -p x`, which names only
 * --bogus as unknown, and `--version` proves nothing: it short-circuits
 * option validation). The changelog shows --setting-sources in use by
 * 2.0.24, --tools by 2.1.0, --strict-mcp-config by 2.1.143 and --max-turns
 * by 2.1.205 (first MENTIONS, not introductions); an older CLI rejects an
 * unknown option loudly (exit 1, "error: unknown option"), which
 * `crosscheck doctor`'s runner probe prints verbatim. The FLOOR is a
 * different matter from the flags: below Claude Code 2.1.101 (core
 * SUMMARIZER_CLAUDE_MIN_VERSION) `--setting-sources ""` — no `user` source
 * — let the CLI's background cleanup ignore cleanupPeriodDays and delete
 * transcripts older than 30 days; the argv is the same on every version,
 * and doctor WARNs on a CLI below the floor. CROSSCHECK_SUMMARIZER_CMD
 * still replaces the binary WHOLESALE — no flag reaches an override (tests).
 *
 * VERIFY: bun -e 'const {SUMMARIZER_LEAN_FLAGS: f} = await import("./packages/connector-claude/src/summarizer/runner.ts"); console.log(f.filter((x) => x.startsWith("--")).join(" "))'
 * PRINTS: --setting-sources --strict-mcp-config --mcp-config --no-session-persistence --tools --max-turns
 */
export const SUMMARIZER_LEAN_FLAGS: readonly string[] = [
  "--setting-sources",
  "",
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}',
  "--no-session-persistence",
  "--tools",
  "",
  "--max-turns",
  "1",
];

/**
 * SIGKILL follow-up after the polite kill — the same escalation PATTERN as
 * git/git.ts abandonProcess (the figure is its own: 1000 ms here vs
 * GIT_KILL_GRACE_MS 500, because a model process gets more shutdown grace
 * than a local git).
 *
 * VERIFY: grep -c "GIT_KILL_GRACE_MS = 500" packages/connector-core/src/constants.ts
 * PRINTS: 1
 */
const KILL_GRACE_MS = 1000;

/** Race winner when the deadline beats the summarizer. */
const TIMED_OUT = Symbol("crosscheck.summarizer.timed-out");

const MS_PER_SECOND = 1000;

/**
 * The argv to spawn: the override executable alone, or headless claude with
 * the lean flags. The override replaces the binary WHOLESALE (no argument
 * splicing — an operator or test owns the whole contract: slice on stdin,
 * output on stdout). `-p <PROMPT>` stays first so a reader of `ps` sees
 * what the process is for before the flag tail.
 */
export const resolveSummarizerArgv = (env: Env): readonly string[] => {
  const override = env["CROSSCHECK_SUMMARIZER_CMD"];
  if (override !== undefined && override.length > 0) {
    return [override];
  }
  return [
    "claude",
    "-p",
    SUMMARIZER_PROMPT,
    "--model",
    SUMMARIZER_MODEL,
    ...SUMMARIZER_LEAN_FLAGS,
  ];
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

/** A piped stdio stream read bounded; an ignored one ("ignore", a number) reads as "". */
const readPipe = (stream: unknown): Promise<string> =>
  stream instanceof ReadableStream
    ? readBounded(stream as ReadableStream<Uint8Array>, SUMMARIZER_OUTPUT_MAX_BYTES)
    : Promise.resolve("");

interface SummarizerOutcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface SummarizerSuccess {
  readonly ok: true;
  readonly stdout: string;
  /** Empty unless `captureStderr` was asked for — the worker never asks. */
  readonly stderr: string;
  readonly elapsedMs: number;
}

/**
 * Why a run produced no answer, for the worker to BOOK (trial finding #14:
 * 17 of 17 fires lost and no surface knew why) and for doctor to print.
 * `detail` is what the binary said — RAW and untrusted; only
 * formatSummarizerFailure below renders it, through bareUntrusted.
 */
export type SummarizerFailure =
  | {
      readonly ok: false;
      readonly reason: "spawn";
      /** The spawn error's message — a missing binary, a bad cwd. */
      readonly detail: string;
      readonly elapsedMs: number;
    }
  | {
      readonly ok: false;
      readonly reason: "exit";
      readonly exitCode: number;
      /** First non-empty STDOUT line, else the first stderr line IF captured. */
      readonly detail: string;
      readonly elapsedMs: number;
    }
  | {
      readonly ok: false;
      readonly reason: "timeout";
      readonly timeoutMs: number;
      readonly elapsedMs: number;
    };

export type SummarizerResult = SummarizerSuccess | SummarizerFailure;

export interface RunSummarizerOptions {
  /**
   * Working directory of the spawned binary. The worker passes the neutral
   * summarizerCwdPath(home) so no repo CLAUDE.md rides into the fire;
   * omitted, the child inherits the caller's cwd.
   */
  readonly cwd?: string | undefined;
  /**
   * Capture stderr into the result. DEFAULT OFF, deliberately: the worker
   * never reads stderr, so nothing from it can be stored or shipped (the
   * privacy stance of the booked failure text). Doctor's probe turns it on
   * because a human is reading, and "error: unknown option '--tools'" goes
   * to stderr.
   */
  readonly captureStderr?: boolean;
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

const firstLine = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The hub key's env name (core config/config.ts reads it). The nested binary
 * never talks to the hub — its whole contract is slice on stdin, answer on
 * stdout — so a secret the developer exported for the hooks stops HERE and
 * does not ride into a third-party process that has no use for it.
 */
const HUB_KEY_ENV = "CROSSCHECK_API_KEY";

/**
 * The child's environment: the caller's, undefined values and the hub key
 * dropped, plus the child marker — set HERE as well as by
 * summarizer/worker-env.ts, so the nested claude carries it even when a
 * caller built the env by hand (the doctor probe, an operator's one-off).
 */
const childEnv = (env: Env): Record<string, string> => ({
  ...Object.fromEntries(
    Object.entries(env).flatMap(([name, value]) =>
      value === undefined || name === HUB_KEY_ENV ? [] : [[name, value]],
    ),
  ),
  [SUMMARIZER_CHILD_ENV]: SUMMARIZER_CHILD_ON,
});

/**
 * Runs the summarizer over one slice: slice on stdin, stdout captured and
 * bounded, the whole CALL bounded by `timeoutMs`. Never throws: a missing
 * binary, a non-zero exit and the deadline each come back as a typed
 * failure, because a lost draft costs nothing and a loud one costs trust
 * (fail open, like every capture path) — but the REASON is returned, so the
 * worker can book it and doctor can say it (trial finding #14).
 *
 * THE DEADLINE BOUNDS THE CALL, NOT THE CHILD — the runGit lesson
 * (git/git.ts), relearned here after this runner shipped without it. A
 * `claude` that is a wrapper or tee can leave a DESCENDANT holding the
 * inherited stdout pipe after the direct child exits; a read awaited past
 * the kill then pends for that descendant's whole lifetime — one stranded
 * worker process per fire, invisible to doctor. So the deadline races the
 * read: when it fires the caller gets the timeout failure immediately, the
 * child is signalled without being waited on, and the abandoned read
 * settles quietly whenever the pipe finally closes. Pinned by the
 * descendant test in test/summarizer-worker.test.ts.
 */
export const runSummarizer = async (
  argv: readonly string[],
  slice: string,
  timeoutMs: number,
  env: Env,
  options: RunSummarizerOptions = {},
): Promise<SummarizerResult> => {
  const startedAt = Date.now();
  const elapsedMs = (): number => Date.now() - startedAt;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn({
      cmd: [...argv],
      stdin: Buffer.from(slice),
      stdout: "pipe",
      stderr: options.captureStderr === true ? "pipe" : "ignore",
      env: childEnv(env),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
  } catch (error) {
    return {
      ok: false,
      reason: "spawn",
      detail: errorMessage(error),
      elapsedMs: elapsedMs(),
    };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolveDeadline) => {
    timer = setTimeout(() => {
      resolveDeadline(TIMED_OUT);
    }, timeoutMs);
  });
  const readAll: Promise<SummarizerOutcome> = (async () => {
    // Both pipes drained CONCURRENTLY: a captured stderr that nobody reads
    // fills its pipe and wedges a chatty binary before stdout ever closes.
    const [stdout, stderr] = await Promise.all([
      readPipe(proc.stdout),
      readPipe(proc.stderr),
    ]);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  })();
  // An abandoned read that later rejects must not surface as an unhandled
  // rejection; the race path below still sees the original settlement.
  readAll.catch(() => undefined);
  try {
    const outcome = await Promise.race([readAll, deadline]);
    if (outcome === TIMED_OUT) {
      abandonProcess(proc);
      return { ok: false, reason: "timeout", timeoutMs, elapsedMs: elapsedMs() };
    }
    if (outcome.exitCode !== 0) {
      const said = firstLine(outcome.stdout);
      return {
        ok: false,
        reason: "exit",
        exitCode: outcome.exitCode,
        detail: said.length > 0 ? said : firstLine(outcome.stderr),
        elapsedMs: elapsedMs(),
      };
    }
    return {
      ok: true,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      elapsedMs: elapsedMs(),
    };
  } catch (error) {
    // A rejection AFTER a successful spawn — the pipe read or the exit wait
    // — lands here and is booked under the "spawn" label too ("could not
    // start: …"), which is a misnomer for that case. Not reproduced (no
    // cheap way to make a Bun subprocess pipe reject) and bounded: the
    // worker still books it and exits 0. A fourth reason ("read") waits for
    // a reproduction that can show it red first.
    return {
      ok: false,
      reason: "spawn",
      detail: errorMessage(error),
      elapsedMs: elapsedMs(),
    };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * One line of what the binary said, fit for a human surface: the first
 * non-empty line through bareUntrusted — model/CLI output is untrusted and
 * must not mint renderer structure or carry control characters — bounded
 * to `maxChars`. The ONE door in this package from runner output to the
 * render layer; render-surfaces.ts registers this module for it, and the
 * probe (probe.ts) comes through here rather than importing the layer.
 */
export const bareSummarizerLine = (
  raw: string,
  maxChars: number = SUMMARIZER_FAILURE_MAX_CHARS,
): string => bareUntrusted(firstLine(raw), maxChars);

const LABEL_SEPARATOR = ": ";

/**
 * One line for a failure, fit to be BOOKED in session state and printed by
 * status/doctor: the reason first, then what the binary said (through
 * bareSummarizerLine), the binary's share of the line being whatever
 * SUMMARIZER_FAILURE_MAX_CHARS leaves after the label — so the whole line
 * is bounded by construction and never cut again after the label is added.
 * The one cut it does take, inside bareUntrusted, is the sanitizer's
 * surrogate-safe one (core briefing/cut.ts): a non-BMP character across the
 * bound is dropped whole, never left as a lone high surrogate.
 *
 * ACCEPTED TRADE-OFF: bareUntrusted is the BARE class as core defines it,
 * phrase filter included, so a CLI line that happens to read like an
 * instruction ("You must run /login first", "unknown option
 * '--override-settings'") is booked as `exit 1: [redacted title looked like
 * an instruction]` — the exit code survives, the text does not. A class
 * without the filter just for this line would be a fourth class for one
 * surface that an agent CAN read (a Bash `crosscheck doctor`), and the two
 * lines actually seen on 2.1.237 ("Not logged in · Please run /login",
 * "error: unknown option '--tools'") pass untouched; doctor's remedy tests
 * the RAW detail, so its advice is unaffected by the redaction.
 *
 * VERIFY: bun -e 'const {formatSummarizerFailure: f} = await import("./packages/connector-claude/src/summarizer/runner.ts"); console.log(f({ok:false,reason:"exit",exitCode:1,detail:"Not logged in · Please run /login",elapsedMs:1}), "|", f({ok:false,reason:"timeout",timeoutMs:60000,elapsedMs:60000}), "|", f({ok:false,reason:"spawn",detail:"Executable not found in $PATH: \"claude\"",elapsedMs:1}), "|", f({ok:false,reason:"exit",exitCode:2,detail:"z".repeat(500),elapsedMs:1}).length)'
 * PRINTS: exit 1: Not logged in Please run /login | timed out after 60 s | could not start: Executable not found in $PATH "claude" | 120
 */
export const formatSummarizerFailure = (failure: SummarizerFailure): string => {
  if (failure.reason === "timeout") {
    return `timed out after ${String(Math.round(failure.timeoutMs / MS_PER_SECOND))} s`;
  }
  const label =
    failure.reason === "spawn"
      ? "could not start"
      : `exit ${String(failure.exitCode)}`;
  const said = bareSummarizerLine(
    failure.detail,
    SUMMARIZER_FAILURE_MAX_CHARS - label.length - LABEL_SEPARATOR.length,
  );
  return said.length === 0 ? label : `${label}${LABEL_SEPARATOR}${said}`;
};
