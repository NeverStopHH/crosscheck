/**
 * WHAT A REPO TRIES TO HAND BUN (security review C1/H1, defence in depth).
 *
 * crosscheck starts every process with `--no-env-file` and its own bunfig
 * (connector-core config/runtime-isolation.ts), so a repo's bunfig `preload`
 * and its `.env` files reach no crosscheck process. They still reach a hook
 * command written by crosscheck 0.10.0 or older (doctor's launcher line says
 * whether this machine still has one) and any `bun` a person runs by hand
 * here. So when the cwd or the repo root carries a top-level `preload`, or a
 * `.env*` naming a crosscheck setting, a proxy or TLS verification, doctor
 * says so. Only key NAMES are printed — a value is the repo's text and may be
 * a credential. Nothing found prints nothing, so a clean repo's report is
 * unchanged.
 */
import { join } from "node:path";

import { readTextOrNull } from "@crosscheck/connector-core/config/paths.ts";

import type { Check } from "./doctor.ts";

const BUNFIG_NAMES = ["bunfig.toml", ".bunfig.toml"] as const;
const ENV_FILE_NAMES = [".env", ".env.local", ".env.development", ".env.production", ".env.test"] as const;

/** Keys that steer where crosscheck reports, which key it uses, or how its requests travel. */
const STEERING_KEY_PATTERN = /^(CROSSCHECK_[A-Z0-9_]+|HTTPS?_PROXY|ALL_PROXY|NODE_TLS_REJECT_UNAUTHORIZED)$/i;

const MAX_NAMED_KEYS = 6;

/** A `preload` before the first `[section]` header — the one bun applies to `bun <file>`. */
export const hasTopLevelPreload = (toml: string): boolean => {
  const firstSection = toml.search(/^\s*\[/m);
  const topLevel = firstSection === -1 ? toml : toml.slice(0, firstSection);
  return /^\s*preload\s*=/m.test(topLevel);
};

/** The steering key names a dotenv text sets (`export K=…` and `K=…`), deduplicated. */
export const steeringKeysIn = (dotenv: string): readonly string[] => [
  ...new Set(
    dotenv
      .split("\n")
      .map((line) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1] ?? null)
      .filter((key): key is string => key !== null && STEERING_KEY_PATTERN.test(key)),
  ),
];

interface Finding {
  readonly path: string;
  readonly what: string;
}

const findingsIn = async (dir: string): Promise<readonly Finding[]> => {
  const bunfigs = await Promise.all(
    BUNFIG_NAMES.map(async (name): Promise<Finding | null> => {
      const path = join(dir, name);
      const text = await readTextOrNull(path);
      return text !== null && hasTopLevelPreload(text) ? { path, what: "a bun preload" } : null;
    }),
  );
  const envs = await Promise.all(
    ENV_FILE_NAMES.map(async (name): Promise<Finding | null> => {
      const path = join(dir, name);
      const text = await readTextOrNull(path);
      const keys = text === null ? [] : steeringKeysIn(text);
      if (keys.length === 0) {
        return null;
      }
      const shown = keys.slice(0, MAX_NAMED_KEYS).join(", ");
      const more = keys.length > MAX_NAMED_KEYS ? ` (+${String(keys.length - MAX_NAMED_KEYS)} more)` : "";
      return { path, what: `${shown}${more}` };
    }),
  );
  return [...bunfigs, ...envs].filter((finding): finding is Finding => finding !== null);
};

/** Empty when neither the cwd nor the repo root tries to steer bun. */
export const repoRuntimeChecks = async (cwd: string, repoRoot: string | null): Promise<readonly Check[]> => {
  const dirs = [...new Set([cwd, ...(repoRoot === null ? [] : [repoRoot])])];
  const findings = (await Promise.all(dirs.map(findingsIn))).flat();
  if (findings.length === 0) {
    return [];
  }
  const listed = findings.map((finding) => `${finding.path} sets ${finding.what}`).join("; ");
  return [
    {
      level: "WARN",
      name: "repo runtime files",
      detail:
        `${listed}. crosscheck itself starts bun without reading them (--no-env-file and its own bunfig), ` +
        "but a hook command from crosscheck 0.10.0 or older, or bun run by hand here, would load them — " +
        "if the launcher line above WARNs, rerun crosscheck init",
    },
  ];
};
