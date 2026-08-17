import { z } from "zod";

import {
  EXIT_FAIL,
  EXIT_OK,
  EXIT_UNREACHABLE,
  EXIT_USAGE,
  HTTP_TIMEOUT_MS,
  LOGIN_STDIN_TIMEOUT_MS,
  MS_PER_SECOND,
  PROBE_REPO,
} from "../constants.ts";
import { normalizeHubUrl, readStoredConfig, saveConfig } from "../config/config.ts";
import { crosscheckHome, ensureDir } from "../config/paths.ts";
import type { Env } from "../config/paths.ts";
import { hubRequest } from "../http/client.ts";

export interface CliResult {
  readonly stdout: string;
  readonly exitCode: number;
}

const HTTP_UNAUTHORIZED = 401;

/**
 * Auth is checked before the repo lookup, so a nonsense repo name is the
 * cheapest possible credential probe.
 */
export const probeCredentials = async (
  hubUrl: string,
  apiKey: string,
  timeoutMs: number,
): Promise<{ readonly ok: boolean; readonly status: number }> => {
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
  return result.ok
    ? { ok: true, status: 200 }
    : { ok: false, status: result.status };
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

  const probe = await probeCredentials(hubUrl, apiKey, HTTP_TIMEOUT_MS);
  if (!probe.ok) {
    if (probe.status === HTTP_UNAUTHORIZED) {
      return { stdout: "invalid api key\n", exitCode: EXIT_FAIL };
    }
    return {
      stdout: `hub unreachable: ${hubUrl}\n`,
      exitCode: EXIT_UNREACHABLE,
    };
  }

  const home = crosscheckHome(env);
  await ensureDir(home);
  const existing = await readStoredConfig(home);
  await saveConfig(home, {
    ...(existing ?? {}),
    version: 1,
    hubUrl,
    apiKey,
  });
  return { stdout: `logged in to ${hubUrl}\n`, exitCode: EXIT_OK };
};
