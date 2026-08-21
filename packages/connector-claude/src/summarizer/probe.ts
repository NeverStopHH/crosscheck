/**
 * The doctor's ACTIVE probe of the Tier-1 runner (trial finding #14, hard-won
 * rule 5: fail-open must never mean silently dead). For a whole trial the
 * summarizer fired 17 times and answered nothing, and every surface read
 * PASS, because each fire died inside a detached worker whose stdio nobody
 * saw. This runs the REAL argv (runner.ts resolveSummarizerArgv) with the
 * REAL worker env (worker-env.ts) from the REAL neutral cwd, on a fixed
 * slice that must answer NONE, with stderr captured because a human is
 * reading — and hands back what happened, timed against the real deadline.
 *
 * COST: one Haiku call per `crosscheck doctor`, on the developer's own
 * quota. Doctor is a manual diagnostic, so that is acceptable and said in
 * the README; CROSSCHECK_DOCTOR_NO_PROBE=1 skips it, and so does a PATH
 * with no claude on it (the worker would fail the same way, and CI/tests
 * have no claude — tests reach the probe only through a fake
 * CROSSCHECK_SUMMARIZER_CMD, never a real binary).
 */
import {
  DOCTOR_NO_PROBE_ENV,
  DOCTOR_SUMMARIZER_PROBE_SLICE,
  DOCTOR_SUMMARIZER_VERSION_TIMEOUT_MS,
} from "@crosscheck/connector-core/constants.ts";
import { bareUntrusted } from "@crosscheck/connector-core/briefing/sanitize.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { isNoneAnswer } from "./parse.ts";
import {
  resolveSummarizerArgv,
  resolveSummarizerTimeoutMs,
  runSummarizer,
} from "./runner.ts";
import type { SummarizerFailure } from "./runner.ts";
import { ensureSummarizerCwd, summarizerWorkerEnv } from "./worker-env.ts";

/** The binary the default argv names — what the PATH check looks for. */
const CLAUDE_BINARY = "claude";

export type SummarizerProbe =
  | { readonly kind: "skipped"; readonly why: string }
  | {
      readonly kind: "answered";
      /** True when the model said NONE — the expected answer to the probe slice. */
      readonly none: boolean;
      /** The first stdout line, sanitized — shown when the answer was not NONE. */
      readonly firstLine: string;
      readonly elapsedMs: number;
      readonly version: string | null;
    }
  | {
      /** Exit 0 with nothing on stdout: the binary ran and said nothing. */
      readonly kind: "empty";
      readonly elapsedMs: number;
      readonly version: string | null;
    }
  | {
      readonly kind: "failed";
      readonly failure: SummarizerFailure;
      readonly version: string | null;
    };

const firstLine = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";

/**
 * `claude --version` through the same bounded runner (no second process
 * helper to maintain): it prints "2.1.237 (Claude Code)" on the machine
 * this was built on, and the first token is the version. Only for the real
 * binary — an override is the operator's, and its `--version` means
 * whatever they made it mean.
 */
const readClaudeVersion = async (
  binary: string,
  env: Env,
  cwd: string | undefined,
): Promise<string | null> => {
  const result = await runSummarizer(
    [binary, "--version"],
    "",
    DOCTOR_SUMMARIZER_VERSION_TIMEOUT_MS,
    env,
    { cwd },
  );
  if (!result.ok) {
    return null;
  }
  const token = bareUntrusted(firstLine(result.stdout)).split(" ")[0] ?? "";
  return token.length === 0 ? null : token;
};

export const probeSummarizerRunner = async (
  env: Env,
  home: string,
): Promise<SummarizerProbe> => {
  if (env[DOCTOR_NO_PROBE_ENV] === "1") {
    return { kind: "skipped", why: `${DOCTOR_NO_PROBE_ENV}=1` };
  }
  const override = env["CROSSCHECK_SUMMARIZER_CMD"];
  const hasOverride = override !== undefined && override.length > 0;
  // The DOCTOR's PATH, not the test runner's: Bun.spawn falls back to the
  // parent's PATH when the child env has none, so a bare "claude" in a test
  // env without PATH would still find the developer's real binary. The
  // which() below is what keeps a real Haiku call out of every doctor test
  // on a machine that has claude installed.
  if (
    !hasOverride &&
    Bun.which(CLAUDE_BINARY, { PATH: env["PATH"] ?? "" }) === null
  ) {
    return {
      kind: "skipped",
      why: `no ${CLAUDE_BINARY} binary on PATH (Tier-1 capture needs Claude Code; a Cursor- or ACP-only machine can ignore this)`,
    };
  }
  const argv = resolveSummarizerArgv(env);
  const workerEnv = summarizerWorkerEnv(env, home);
  const cwd = await ensureSummarizerCwd(home);
  const version = hasOverride
    ? null
    : await readClaudeVersion(argv[0] ?? CLAUDE_BINARY, workerEnv, cwd);
  const result = await runSummarizer(
    argv,
    DOCTOR_SUMMARIZER_PROBE_SLICE,
    resolveSummarizerTimeoutMs(env),
    workerEnv,
    { cwd, captureStderr: true },
  );
  if (!result.ok) {
    return { kind: "failed", failure: result, version };
  }
  const line = firstLine(result.stdout);
  if (line.length === 0) {
    return { kind: "empty", elapsedMs: result.elapsedMs, version };
  }
  return {
    kind: "answered",
    none: isNoneAnswer(result.stdout),
    firstLine: bareUntrusted(line),
    elapsedMs: result.elapsedMs,
    version,
  };
};
