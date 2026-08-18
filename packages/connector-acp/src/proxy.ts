/**
 * `crosscheck acp -- <agent command…>` — the Block 3 skeleton (design §5
 * row 3): a transparent stdio pipe around a real ACP agent. No capture, no
 * injection; those are Blocks 4 and 5. What exists is the §2.2 process
 * model: pipes only, bytes verbatim, stderr passthrough, exit codes and
 * signals faithful in both directions, and observability (log, `--record`,
 * drop counters) that rides a COPY of the wire and can never touch it.
 *
 * PLUMBING, measured not chosen (fd-io.ts header carries the numbers), one
 * lane per direction because each is the only shape that both applies real
 * backpressure AND keeps ordinary pipe semantics for the agent:
 *
 *   - client → agent: blocking reads on our fd 0, written into the agent's
 *     REAL stdin pipe (node:child_process — its write side holds at the
 *     kernel buffer, and closing it is an ordinary pipe EOF; a FIFO here
 *     would break agents whose runtime never reports FIFO-EOF on stdin —
 *     observed with Bun's own stdin stream);
 *   - agent → client, agent stderr: two FIFOs the shell wires over the
 *     agent's fd 1/2 at exec time, read here with blocking reads (nothing
 *     is pulled until forwarded, so a flood fills the KERNEL buffer and
 *     stalls the agent, not this process) and forwarded with blocking
 *     writes to our fd 1/2 (a slow client stalls us the same way).
 *
 * The agent runs under `sh -c 'exec "$0" "$@" > out 2> err'`: argv passes
 * through `"$@"` untouched, environment inherited, and `exec` replaces the
 * shell so the child pid IS the agent — signals and exit codes need no
 * translation. EOF semantics survive end to end: client stdin EOF → we end
 * the agent's stdin pipe; agent exit → its FIFO ends close → our reads EOF.
 *
 * Block-3 deviation from §2.3 rule 3, stated: forwarding is CHUNK-granular,
 * not line-granular — stronger transparency than the rule asks for (a
 * partial line is already on its way before its newline arrives), and the
 * observer cannot affect forwarding even by crashing, because forwarding
 * never waits for it. Line-granular handling arrives with Block 5's two
 * write points, on the client→agent path only.
 */
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";

import { EXIT_FAIL, EXIT_OK, EXIT_USAGE } from "@crosscheck/connector-core/constants.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { crosscheckHome } from "@crosscheck/connector-core/kit.ts";

import { ACP_USAGE, isUsageError, parseAcpArgs } from "./cli.ts";
import {
  ACP_EXIT_FLUSH_TIMEOUT_MS,
  EXIT_SPAWN_FAILURE,
  SIGNAL_EXIT_BASE,
} from "./constants.ts";
import {
  STDERR_FD,
  STDIN_FD,
  STDOUT_FD,
  closeFd,
  fdByteSink,
  fdSource,
  openFd,
} from "./fd-io.ts";
import { createAcpLogger } from "./logger.ts";
import type { AcpLogger } from "./logger.ts";
import { createLineObserver } from "./observer.ts";
import type { LineObserver } from "./observer.ts";
import { pumpBytes } from "./pump.ts";
import type { ByteSink, ChunkObserver, PumpOutcome } from "./pump.ts";
import { createAcpRecorder } from "./recorder.ts";
import type { AcpRecorder, RecordDirection } from "./recorder.ts";

/** Relayed to the child so ctrl-C and a polite kill behave unproxied (§2.2). */
const RELAYED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** POSIX default-termination numbers for the 128+n fallback. */
const SIGNAL_NUMBERS: Readonly<Record<string, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGABRT: 6,
  SIGKILL: 9,
  SIGSEGV: 11,
  SIGPIPE: 13,
  SIGTERM: 15,
};
const FALLBACK_SIGNAL_NUMBER = 15;

/**
 * Redirects in the exec line, `"$0" "$@"` for the argv: the shell only
 * plumbs fds and then replaces itself with the agent. Paths come from
 * mkdtemp (no quoting hazards), argv never passes through shell parsing.
 */
const SHELL_EXEC_SCRIPT = (a2c: string, err: string): string =>
  `exec "$0" "$@" > '${a2c}' 2> '${err}'`;

/**
 * The agent's stdin pipe as a ByteSink. The write CALLBACK (not the
 * write() return value) is the resolution: it fires once the data reached
 * the OS, which is both the backpressure the pump awaits and the moment
 * the source may reuse its buffer (the pump's chunk contract).
 */
const writableByteSink = (writable: Writable): ByteSink => ({
  write(chunk) {
    return new Promise<void>((resolve, reject) => {
      if (writable.destroyed) {
        reject(new Error("stream destroyed"));
        return;
      }
      writable.write(chunk, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  },
});

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Push the copy through the observer; hand completed lines to the record. */
const observeInto = (
  observer: LineObserver,
  recorder: AcpRecorder | null,
  direction: RecordDirection,
): ChunkObserver => {
  return (copy) => {
    const events = observer.push(copy);
    if (recorder === null) return;
    for (const event of events) {
      recorder.record(direction, event, Date.now());
    }
  };
};

const flushObservability = async (
  logger: AcpLogger,
  recorder: AcpRecorder | null,
): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bounded = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ACP_EXIT_FLUSH_TIMEOUT_MS);
  });
  const flushes = Promise.all([
    logger.flush(),
    recorder?.flush() ?? Promise.resolve(),
  ]).then(() => undefined);
  await Promise.race([flushes, bounded]);
  clearTimeout(timer);
};

/**
 * Mirror a child's death-by-signal as our own death by the SAME signal, so
 * the client's waitpid cannot tell the proxy was ever there. The re-raise
 * normally terminates before the return; the 128+n exit is the fallback for
 * a blocked or unknown signal.
 */
const mirrorSignalDeath = (signalCode: string): number => {
  try {
    process.removeAllListeners(signalCode as NodeJS.Signals);
  } catch {
    // not a listenable signal (SIGKILL): nothing to remove
  }
  try {
    process.kill(process.pid, signalCode as NodeJS.Signals);
  } catch {
    // unknown signal name — fall through to the numeric exit
  }
  return SIGNAL_EXIT_BASE + (SIGNAL_NUMBERS[signalCode] ?? FALLBACK_SIGNAL_NUMBER);
};

const summarize = (
  logger: AcpLogger,
  label: RecordDirection,
  observer: LineObserver,
  outcome: PumpOutcome | null,
): void => {
  const counts = observer.counters();
  const observerErrors =
    outcome === null ? "" : ` observer-errors=${outcome.observerErrors}`;
  logger.line(
    `${label} bytes=${counts.bytes} lines=${counts.lines} ` +
      `unparseable=${counts.unparseable} oversized=${counts.oversized}${observerErrors}`,
  );
};

interface ChildEnd {
  readonly code: number | null;
  readonly signal: string | null;
  /** Set when even the shell could not be spawned. */
  readonly spawnError: Error | undefined;
}

const watchChildEnd = (child: ChildProcess): Promise<ChildEnd> =>
  new Promise((resolve) => {
    child.once("error", (error) => {
      resolve({ code: null, signal: null, spawnError: error });
    });
    child.once("exit", (code, signal) => {
      resolve({ code, signal, spawnError: undefined });
    });
  });

/**
 * The pre-spawn existence check — pure UX. It exists so a typo'd agent name
 * fails with OUR one-line reason instead of only the shell's; the shell's
 * own 126/127 stays the backstop for everything this cannot see (TOCTOU,
 * exec-format errors).
 */
const isSpawnable = (command: string): boolean => {
  if (command.includes("/")) {
    try {
      accessSync(command, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  return Bun.which(command) !== null;
};

export const runAcpProxy = async (
  args: readonly string[],
  env: Env,
): Promise<number> => {
  const parsed = parseAcpArgs(args);
  if (isUsageError(parsed)) {
    // Loud, and BEFORE any spawn: no session exists yet to protect.
    process.stderr.write(`crosscheck acp: ${parsed.error}\n\n${ACP_USAGE}\n`);
    return EXIT_USAGE;
  }

  const logger = await createAcpLogger(crosscheckHome(env), process.pid);
  const recorder =
    parsed.recordPath === undefined ? null : createAcpRecorder(parsed.recordPath);
  logger.line(`start pid=${process.pid} agent=${JSON.stringify(parsed.command)}`);

  const [executable, ...agentArgs] = parsed.command;
  if (executable === undefined || !isSpawnable(executable)) {
    const reason = `not found or not executable: ${executable ?? ""}`;
    process.stderr.write(`crosscheck acp: cannot spawn agent (${reason})\n`);
    logger.line(`spawn-failure ${reason}`);
    await flushObservability(logger, recorder);
    return EXIT_SPAWN_FAILURE;
  }

  // The outbound wire: two FIFOs in a private temp dir (header says why).
  const fifoDir = await mkdtemp(join(tmpdir(), "crosscheck-acp-"));
  const a2cPath = join(fifoDir, "a2c");
  const errPath = join(fifoDir, "err");
  const cleanupFifos = (): Promise<void> =>
    rm(fifoDir, { recursive: true, force: true }).catch(() => undefined);
  const mkfifo = spawnSync("mkfifo", [a2cPath, errPath]);
  if (mkfifo.status !== 0) {
    process.stderr.write("crosscheck acp: cannot create the agent pipes (mkfifo failed)\n");
    logger.line("spawn-failure mkfifo");
    await cleanupFifos();
    await flushObservability(logger, recorder);
    return EXIT_FAIL;
  }

  const child = spawn(
    "/bin/sh",
    ["-c", SHELL_EXEC_SCRIPT(a2cPath, errPath), executable, ...agentArgs],
    { stdio: ["pipe", "ignore", "ignore"] },
  );
  const childEnd = watchChildEnd(child);
  if (child.stdin === null) {
    // Cannot happen with stdio[0] = "pipe"; belt for the type system.
    await cleanupFifos();
    await flushObservability(logger, recorder);
    return EXIT_FAIL;
  }
  const agentStdin = child.stdin;
  // An 'error' event with no listener crashes the process — the pump sees
  // failures through its own write callbacks instead.
  agentStdin.on("error", () => {});

  for (const signal of RELAYED_SIGNALS) {
    process.on(signal, () => {
      logger.line(`relay ${signal}`);
      try {
        child.kill(signal);
      } catch {
        // child already gone — its exit mirrors on its own
      }
    });
  }

  // FIFO opens BLOCK until the shell opens its ends (its redirects, in
  // order), so they are raced against a child that dies before plumbing.
  const opens = Promise.all([openFd(a2cPath, "r"), openFd(errPath, "r")]);
  const earlyEnd = await Promise.race([opens.then(() => null), childEnd]);
  if (earlyEnd !== null) {
    // The child died before the wire existed. Blocked opens cannot be
    // cancelled; close whatever they eventually return and exit faithfully.
    void opens
      .then((fds) => {
        for (const fd of fds) closeFd(fd);
      })
      .catch(() => undefined);
    await cleanupFifos();
    if (earlyEnd.spawnError !== undefined) {
      const reason = describeError(earlyEnd.spawnError);
      process.stderr.write(`crosscheck acp: cannot spawn agent (${reason})\n`);
      logger.line(`spawn-failure ${reason}`);
      await flushObservability(logger, recorder);
      return EXIT_SPAWN_FAILURE;
    }
    logger.line(
      `exit-before-plumbing code=${earlyEnd.code ?? "none"} signal=${earlyEnd.signal ?? "none"}`,
    );
    await flushObservability(logger, recorder);
    if (earlyEnd.signal !== null) return mirrorSignalDeath(earlyEnd.signal);
    return earlyEnd.code ?? EXIT_OK;
  }
  const [agentStdoutFd, agentStderrFd] = await opens;

  let agentStdinEnded = false;
  const endAgentStdin = (): void => {
    if (agentStdinEnded) return;
    agentStdinEnded = true;
    try {
      agentStdin.end(); // the agent's EOF — the one the client meant
    } catch {
      // already closed
    }
  };

  const c2aObserver = createLineObserver();
  const a2cObserver = createLineObserver();

  // client → agent. Whatever ends this pump — client EOF or a dead child —
  // ending the agent's stdin hands it the EOF it would have seen unproxied
  // (§2.2 lifecycle).
  const c2aPump = pumpBytes(
    fdSource(STDIN_FD),
    writableByteSink(agentStdin),
    observeInto(c2aObserver, recorder, "c2a"),
  ).then((outcome) => {
    endAgentStdin();
    if (outcome.writeError !== undefined) {
      logger.line(`agent stdin closed early ${describeError(outcome.writeError)}`);
    }
    return outcome;
  });

  /**
   * agent → client. A write failure here means the client hung up; closing
   * the agent-facing fds gives the agent the same broken-pipe world it
   * would face without us. stdout carries NOTHING but forwarded agent
   * bytes — the spec kills sessions on stray output (§2.2); this is the
   * one client-facing stdout writer in the package:
   *
   * VERIFY: grep -ro "fdByteSink(STDOUT_F[D])" packages/connector-acp/src | wc -l | tr -d ' '
   * PRINTS: 1
   */
  const a2cPump = pumpBytes(
    fdSource(agentStdoutFd),
    fdByteSink(STDOUT_FD),
    observeInto(a2cObserver, recorder, "a2c"),
  ).then((outcome) => {
    if (outcome.writeError !== undefined) {
      logger.line(`client hangup ${describeError(outcome.writeError)}`);
      endAgentStdin();
      closeFd(agentStdoutFd);
    }
    return outcome;
  });

  // agent stderr → our stderr, unmodified, unobserved (§2.2).
  const stderrPump = pumpBytes(fdSource(agentStderrFd), fdByteSink(STDERR_FD));

  const ended = await childEnd;
  // Drain what the agent left in its pipes — transparency includes the
  // tail; the FIFOs EOF once the dead agent's ends are gone.
  const [a2cOutcome] = await Promise.all([a2cPump, stderrPump]);
  // The c2a pump may legitimately never finish (a client holding stdin open
  // past the child's death); take its outcome only if it already has one.
  const c2aOutcome = await Promise.race([
    c2aPump,
    Promise.resolve<PumpOutcome | null>(null),
  ]);
  closeFd(agentStdoutFd);
  closeFd(agentStderrFd);
  endAgentStdin();
  await cleanupFifos();

  // Trailing partial frames become observed (atEof) events for the record.
  for (const event of c2aObserver.end()) {
    recorder?.record("c2a", event, Date.now());
  }
  for (const event of a2cObserver.end()) {
    recorder?.record("a2c", event, Date.now());
  }

  summarize(logger, "c2a", c2aObserver, c2aOutcome);
  summarize(logger, "a2c", a2cObserver, a2cOutcome);
  logger.line(
    `exit code=${ended.code ?? "none"} signal=${ended.signal ?? "none"} ` +
      `record-drops=${recorder?.drops() ?? 0} log-failures=${logger.writeFailures()} ` +
      `log-dropped=${logger.droppedLines()}`,
  );
  await flushObservability(logger, recorder);

  if (ended.signal !== null) {
    return mirrorSignalDeath(ended.signal);
  }
  return ended.code ?? EXIT_OK;
};
