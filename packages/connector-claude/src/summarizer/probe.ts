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
 * CROSSCHECK_SUMMARIZER_CMD, never a real binary). The version it reads is
 * also held against core SUMMARIZER_CLAUDE_MIN_VERSION
 * (isBelowSummarizerVersionFloor below) — doctor WARNs on an older CLI even
 * when the probe answered.
 */
import {
  DOCTOR_NO_PROBE_ENV,
  DOCTOR_SUMMARIZER_PROBE_SLICE,
  DOCTOR_SUMMARIZER_VERSION_TIMEOUT_MS,
  SUMMARIZER_CLAUDE_MIN_VERSION,
} from "@crosscheck/connector-core/constants.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { isNoneAnswer } from "@crosscheck/connector-core/model/parse.ts";
import {
  bareSummarizerLine,
  resolveSummarizerArgv,
  resolveSummarizerTimeoutMs,
  runSummarizer,
} from "@crosscheck/connector-core/model/runner.ts";
import type { SummarizerFailure } from "@crosscheck/connector-core/model/runner.ts";
import { ensureSummarizerCwd, summarizerWorkerEnv } from "@crosscheck/connector-core/model/worker-env.ts";

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
const VERSION_TOKEN_PATTERN = /^(\d+)\.(\d+)\.(\d+)/;

/** "2.1.237" → [2, 1, 237]; "2.1.237-rc1" reads the same; anything else → null. */
const parseVersionToken = (token: string): readonly number[] | null => {
  const match = VERSION_TOKEN_PATTERN.exec(token);
  return match === null
    ? null
    : match.slice(1, 4).map((part) => Number.parseInt(part, 10));
};

/**
 * Below core SUMMARIZER_CLAUDE_MIN_VERSION (2.1.101 — where Claude Code
 * stopped its background cleanup from ignoring cleanupPeriodDays under
 * `--setting-sources` without `user`, the exact shape the lean argv uses).
 * Compared part by part as numbers (2.1.9 < 2.1.101). An unreadable or
 * missing version is NOT below: doctor says what it knows.
 */
export const isBelowSummarizerVersionFloor = (version: string | null): boolean => {
  if (version === null) {
    return false;
  }
  const actual = parseVersionToken(version);
  const floor = parseVersionToken(SUMMARIZER_CLAUDE_MIN_VERSION);
  if (actual === null || floor === null) {
    return false;
  }
  for (let index = 0; index < floor.length; index += 1) {
    const have = actual[index] ?? 0;
    const need = floor[index] ?? 0;
    if (have !== need) {
      return have < need;
    }
  }
  return false;
};

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
  const token = bareSummarizerLine(result.stdout).split(" ")[0] ?? "";
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
  // Looked up against the DOCTOR's env PATH — the same PATH the spawn below
  // resolves "claude" with. Bun.spawn never consults the PARENT process's
  // PATH: a child env without PATH resolves a bare command against the OS
  // default search path only (`ls` in /bin spawns; a binary that is on the
  // parent's PATH but outside that default — /usr/local/bin, ~/.local/bin —
  // is "Executable not found"), measured on Bun 1.3.13/darwin and
  // 1.4.0/linux alike. So a test env without PATH cannot reach a claude in
  // /usr/local/bin at all; without this which() the probe would FAIL "could
  // not start" there instead of saying truthfully that it skipped. The one
  // case the which() actually GUARDS is a claude installed inside the OS
  // default path (/usr/bin), which the spawn would find even with no PATH.
  //
  // VERIFY: d=$(mktemp -d) && printf '#!/bin/sh\necho hi\n' > "$d/cx-probe" && chmod +x "$d/cx-probe" && PATH="$d:$PATH" bun -e 'const t=(env)=>{try{Bun.spawn({cmd:["cx-probe"],env,stdout:"ignore"});return "spawned"}catch(e){return String(e.message).split(":")[0]}};console.log(t({}),"|",t({PATH:process.env.PATH}))'; rm -rf "$d"
  // PRINTS: Executable not found in $PATH | spawned
  //
  // VERIFY: bun -e 'try{const p=Bun.spawn({cmd:["ls"],env:{},stdout:"ignore"});await p.exited;console.log("spawned")}catch(e){console.log(String(e.message).split(":")[0])}'
  // PRINTS: spawned
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
    firstLine: bareSummarizerLine(result.stdout),
    elapsedMs: result.elapsedMs,
    version,
  };
};
