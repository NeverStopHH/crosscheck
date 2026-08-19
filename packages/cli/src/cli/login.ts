import { z } from "zod";

import {
  EXIT_FAIL,
  EXIT_OK,
  EXIT_UNREACHABLE,
  EXIT_USAGE,
  HTTP_TIMEOUT_MS,
  LATENCY_PROBE_TIMEOUT_MS,
  LOGIN_STDIN_TIMEOUT_MS,
  MS_PER_SECOND,
  PROBE_REPO,
} from "@crosscheck/connector-core/constants.ts";
import {
  envTimeoutMs,
  normalizeHubUrl,
  readStoredConfig,
  resolveTimeoutMs,
  saveConfig,
} from "@crosscheck/connector-core/config/config.ts";
import type { Config } from "@crosscheck/connector-core/config/config.ts";
import {
  decideTimeoutUpdate,
  timeoutOwner,
  withTimeoutDecision,
} from "@crosscheck/connector-core/config/timeout-policy.ts";
import type {
  TimeoutDecision,
  TimeoutOwner,
} from "@crosscheck/connector-core/config/timeout-policy.ts";
import { crosscheckHome, ensureDir } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { hubRequest } from "@crosscheck/connector-core/http/client.ts";
import {
  describeConnectionFailure,
  refineRefusedCause,
} from "@crosscheck/connector-core/http/connection-error.ts";
import type { ConnectionCause } from "@crosscheck/connector-core/http/connection-error.ts";
import {
  measureHubLatency,
  recommendedTimeoutMs,
} from "@crosscheck/connector-core/http/latency.ts";
import type { LatencyMeasurement } from "@crosscheck/connector-core/http/latency.ts";

export interface CliResult {
  readonly stdout: string;
  readonly exitCode: number;
}

const HTTP_UNAUTHORIZED = 401;

export interface CredentialProbe {
  readonly ok: boolean;
  readonly status: number;
  /** What the runtime error was, for network failures (connection-error.ts). */
  readonly cause?: ConnectionCause;
  readonly message: string;
}

/**
 * Auth is checked before the repo lookup, so a nonsense repo name is the
 * cheapest possible credential probe.
 */
export const probeCredentials = async (
  hubUrl: string,
  apiKey: string,
  timeoutMs: number,
): Promise<CredentialProbe> => {
  const result = await hubRequest(
    {
      hubUrl,
      apiKey,
      timeoutMs,
      home: "",
      repoKey: "",
      now: () => new Date(),
    },
    {
      method: "GET",
      path: `/api/presence?repo=${encodeURIComponent(PROBE_REPO)}`,
      schema: z.unknown(),
    },
  );
  if (result.ok) {
    return { ok: true, status: 200, message: "" };
  }
  return {
    ok: false,
    status: result.status,
    ...(result.cause === undefined ? {} : { cause: result.cause }),
    message: result.message,
  };
};

export type SecretReader = () => Promise<string | null>;

/**
 * Piped stdin only. An interactive terminal would block on a read the user was
 * never told to make, so a TTY yields nothing and the usage text explains why.
 *
 * A NON-tty stdin that stays open (npm lifecycle scripts, Makefiles,
 * provisioning wrappers all pass one) must not hang either: the reader says
 * on stderr what it is waiting for, then gives up after `timeoutMs` so
 * `runLogin` can answer "no api key supplied" instead of blocking forever.
 * The seams exist for the tests; callers use `readSecretFromStdin` below.
 */
export const stdinSecretReader = (
  timeoutMs: number,
  readText: () => Promise<string> = () => Bun.stdin.text(),
  isTty: () => boolean = () => process.stdin.isTTY === true,
  warn: (line: string) => void = (line) => {
    process.stderr.write(line);
  },
): SecretReader => {
  return async () => {
    if (isTty()) {
      return null;
    }
    warn(
      `reading api key from stdin (giving up in ${String(Math.round(timeoutMs / MS_PER_SECOND))}s) — pipe it, or set CROSSCHECK_API_KEY\n`,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    try {
      const text = await Promise.race([readText().catch(() => ""), expiry]);
      if (text === null) {
        return null;
      }
      const trimmed = text.trim();
      return trimmed.length === 0 ? null : trimmed;
    } finally {
      clearTimeout(timer);
    }
  };
};

export const readSecretFromStdin: SecretReader = stdinSecretReader(
  LOGIN_STDIN_TIMEOUT_MS,
);

/** Safe forms first — a positional key is written to the shell history file. */
export const LOGIN_USAGE = [
  "usage: crosscheck login <hubUrl>              reads the api key from stdin",
  "   or: CROSSCHECK_API_KEY=<key> crosscheck login <hubUrl>",
  "   or: crosscheck login <hubUrl> <apiKey>     discouraged: the key lands in your shell history",
  "",
].join("\n");

/**
 * Login is a human-run command, so its probes wait like the MCP tools rather
 * than like a hook (LATENCY_PROBE_TIMEOUT_MS) — at the hook default, the hub
 * the incident was about (580 ms away over a DERP relay) could never complete
 * a login at all. An explicit setting that is even MORE patient is honoured;
 * a tighter one is not allowed to re-create the incident here.
 */
export const loginProbeTimeoutMs = (env: Env, stored: Config | null): number =>
  Math.max(resolveTimeoutMs(env, stored), LATENCY_PROBE_TIMEOUT_MS);

/** Measures the hub's distance; injectable so tests never time real network. */
export type LatencyMeasurer = (
  hubUrl: string,
  apiKey: string,
) => Promise<LatencyMeasurement | null>;

const defaultMeasurer: LatencyMeasurer = (hubUrl, apiKey) =>
  measureHubLatency(
    async () => (await probeCredentials(hubUrl, apiKey, LATENCY_PROBE_TIMEOUT_MS)).ok,
    () => Date.now(),
  );

/**
 * The one honest line: what was measured, what was chosen, and — when a value
 * is deliberately NOT touched — whose value stood in the way and why.
 */
const renderLatencyLine = (
  env: Env,
  stored: Config | null,
  owner: TimeoutOwner,
  measurement: LatencyMeasurement | null,
  decision: TimeoutDecision,
): string => {
  if (measurement === null) {
    return "hub latency not measured (probes failed) — timeout settings unchanged\n";
  }
  const away = `hub is ${String(measurement.medianRttMs)} ms away (median of ${String(measurement.samples)} probes)`;
  if (owner === "env") {
    return `${away} — CROSSCHECK_TIMEOUT_MS=${String(envTimeoutMs(env))} takes precedence; config untouched\n`;
  }
  if (owner === "manual") {
    return `${away} — keeping timeoutMs ${String(stored?.timeoutMs)} ms (set by hand; login only rewrites values it measured itself)\n`;
  }
  if (decision.kind === "store") {
    return `${away} — storing timeoutMs ${String(decision.timeoutMs)} ms (the default ${String(HTTP_TIMEOUT_MS)} ms is too tight this far out)\n`;
  }
  // Reset: when a stale measured value is being REMOVED, say so — a silently
  // vanished timeoutMs would make the config diff inexplicable.
  const retired =
    stored?.timeoutMs === undefined
      ? ""
      : ` (retiring stored ${String(stored.timeoutMs)} ms)`;
  return `${away} — the default ${String(HTTP_TIMEOUT_MS)} ms timeout fits${retired}\n`;
};

const resolveApiKey = async (
  positional: string | undefined,
  env: Env,
  readSecret: SecretReader,
): Promise<string | null> => {
  const supplied = positional ?? env["CROSSCHECK_API_KEY"];
  if (supplied !== undefined && supplied.length > 0) {
    return supplied;
  }
  return readSecret();
};

export const runLogin = async (
  args: readonly string[],
  env: Env,
  readSecret: SecretReader = readSecretFromStdin,
  measure: LatencyMeasurer = defaultMeasurer,
): Promise<CliResult> => {
  const [rawHubUrl, positionalKey] = args;
  if (rawHubUrl === undefined) {
    return { stdout: LOGIN_USAGE, exitCode: EXIT_USAGE };
  }
  const hubUrl = normalizeHubUrl(rawHubUrl);
  if (hubUrl === null) {
    return {
      stdout: `invalid hub url: ${rawHubUrl}\n`,
      exitCode: EXIT_FAIL,
    };
  }
  const apiKey = await resolveApiKey(positionalKey, env, readSecret);
  if (apiKey === null || apiKey.length === 0) {
    return {
      stdout: `no api key supplied\n${LOGIN_USAGE}`,
      exitCode: EXIT_USAGE,
    };
  }

  const home = crosscheckHome(env);
  const existing = await readStoredConfig(home);
  const probeTimeoutMs = loginProbeTimeoutMs(env, existing);
  const probe = await probeCredentials(hubUrl, apiKey, probeTimeoutMs);
  if (!probe.ok) {
    if (probe.status === HTTP_UNAUTHORIZED) {
      return { stdout: "invalid api key\n", exitCode: EXIT_FAIL };
    }
    // Say what actually happened, not "unreachable": a human is watching, so
    // the collapsed could-not-connect is worth one bounded DNS refinement
    // before the sentence is chosen (http/connection-error.ts).
    const cause = await refineRefusedCause(probe.cause ?? "unknown", hubUrl);
    return {
      stdout: `${describeConnectionFailure(
        cause,
        { hubUrl, timeoutMs: probeTimeoutMs },
        probe.message,
      )}\n`,
      exitCode: EXIT_UNREACHABLE,
    };
  }

  // The auth probe succeeded, so the hub is genuinely there — now measure how
  // far, and store a fitting timeout when (and only when) the rule allows
  // (config/timeout-policy.ts: only values login itself measured).
  const measurement = await measure(hubUrl, apiKey);
  const owner = timeoutOwner(env, existing);
  const decision: TimeoutDecision =
    measurement === null
      ? { kind: "keep" }
      : decideTimeoutUpdate(owner, recommendedTimeoutMs(measurement.medianRttMs));
  const latencyLine = renderLatencyLine(env, existing, owner, measurement, decision);

  await ensureDir(home);
  await saveConfig(
    home,
    withTimeoutDecision(
      { ...(existing ?? {}), version: 1, hubUrl, apiKey },
      decision,
    ),
  );
  return {
    stdout: `${latencyLine}logged in to ${hubUrl}\n`,
    exitCode: EXIT_OK,
  };
};
