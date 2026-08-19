import { z } from "zod";

import { DEFAULT_AGENT_KIND, HTTP_TIMEOUT_MS } from "../constants.ts";
import { configPath, crosscheckHome, readJsonOrNull, writePrivateFile } from "./paths.ts";
import type { Env } from "./paths.ts";
import { readRepoConfig } from "./repo-config.ts";

const DenylistSchema = z.object({
  mode: z.enum(["extend", "replace"]),
  patterns: z.array(z.string().min(1)),
});

/**
 * Written beside timeoutMs when LOGIN measured the value; absent — or any
 * other value — means a human set it by hand. The marker is what lets login
 * rewrite its own measurement on the next run without ever silently
 * overwriting a deliberate choice (config/timeout-policy.ts).
 *
 * The schema deliberately does NOT pin the field to this literal: doctor
 * teaches the field's semantics in prose ("set by hand"), which invites
 * edits like "manual" — and a strict parse would turn that one word into
 * readStoredConfig -> null, silently re-creating the tight-timeout incident
 * and letting the next login rebuild the file without developerId or
 * denylist. A junk value degrades to undefined (hand-set) instead
 * (test/config-parse.test.ts).
 */
export const MEASURED_TIMEOUT_SOURCE = "measured";

export const ConfigSchema = z.looseObject({
  version: z.literal(1),
  hubUrl: z.string().min(1),
  apiKey: z.string().min(1),
  developerId: z.string().min(1).optional(),
  developerName: z.string().min(1).optional(),
  denylist: DenylistSchema.optional(),
  timeoutMs: z.number().int().positive().optional(),
  timeoutSource: z.string().optional().catch(undefined),
});

export type Config = z.infer<typeof ConfigSchema>;

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/** Normalizes to a canonical origin+path with no trailing slash, or null. */
export const normalizeHubUrl = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
      return null;
    }
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
  } catch {
    return null;
  }
};

export interface ResolvedConfig {
  readonly home: string;
  readonly hubUrl: string;
  readonly apiKey: string;
  readonly developerId: string | null;
  readonly developerName: string | null;
  readonly denylist: z.infer<typeof DenylistSchema> | null;
  readonly timeoutMs: number;
  readonly agentKind: string;
  /** The stored file, so a write-back preserves fields we do not model. */
  readonly stored: Config | null;
}

export const readStoredConfig = async (home: string): Promise<Config | null> => {
  const parsed = ConfigSchema.safeParse(await readJsonOrNull(configPath(home)));
  return parsed.success ? parsed.data : null;
};

export const saveConfig = async (
  home: string,
  config: Config,
): Promise<void> => {
  await writePrivateFile(
    configPath(home),
    `${JSON.stringify(config, null, 2)}\n`,
  );
};

const parsePositiveInt = (raw: string | undefined): number | null => {
  if (raw === undefined) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

/** The explicit env override, or null — the head of the precedence below. */
export const envTimeoutMs = (env: Env): number | null =>
  parsePositiveInt(env["CROSSCHECK_TIMEOUT_MS"]);

/**
 * Exported because the hook budget must be known before repo identity spawns
 * git, i.e. before a fully resolved config exists.
 */
export const resolveTimeoutMs = (env: Env, stored: Config | null): number =>
  envTimeoutMs(env) ?? stored?.timeoutMs ?? HTTP_TIMEOUT_MS;

export interface LoadConfigOptions {
  readonly env: Env;
  /** Repo root, so the committed .crosscheck.json can supply the hub URL. */
  readonly repoRoot?: string | undefined;
  /**
   * The calling CONNECTOR's declared kind (DESIGN-agent-agnostic.md §1.3) —
   * e.g. `acp:gemini-cli`, `cursor-ide`. Omitted by the Claude connector, so
   * the default stays DEFAULT_AGENT_KIND (claude-code) exactly as before.
   * The CROSSCHECK_AGENT_KIND env override outranks it either way.
   */
  readonly defaultAgentKind?: string | undefined;
}

/**
 * Precedence: env > repo .crosscheck.json (hub URL only) > ~/.crosscheck.
 * Returns null when the connector is not usable — callers then no-op silently.
 */
export const loadConfig = async (
  options: LoadConfigOptions,
): Promise<ResolvedConfig | null> => {
  const { env } = options;
  const home = crosscheckHome(env);
  const stored = await readStoredConfig(home);
  const repoConfig =
    options.repoRoot === undefined ? null : await readRepoConfig(options.repoRoot);

  const hubCandidate =
    env["CROSSCHECK_HUB_URL"] ?? repoConfig?.hubUrl ?? stored?.hubUrl;
  const apiKey = env["CROSSCHECK_API_KEY"] ?? stored?.apiKey;
  if (hubCandidate === undefined || apiKey === undefined) {
    return null;
  }
  const hubUrl = normalizeHubUrl(hubCandidate);
  if (hubUrl === null) {
    return null;
  }

  return {
    home,
    hubUrl,
    apiKey,
    developerId: stored?.developerId ?? null,
    developerName: stored?.developerName ?? null,
    denylist: stored?.denylist ?? null,
    timeoutMs: resolveTimeoutMs(env, stored),
    agentKind:
      env["CROSSCHECK_AGENT_KIND"] ??
      options.defaultAgentKind ??
      DEFAULT_AGENT_KIND,
    stored,
  };
};

export const isDisabled = (env: Env): boolean =>
  env["CROSSCHECK_DISABLED"] === "1";

/** Learned identity is written back once, never asked for (spec §A). */
export const rememberDeveloper = async (
  config: ResolvedConfig,
  developerId: string,
  developerName: string | null,
): Promise<void> => {
  const base = config.stored;
  if (base === null) {
    return;
  }
  const nextName = developerName ?? base.developerName;
  const isUnchanged =
    base.developerId === developerId && base.developerName === nextName;
  if (isUnchanged) {
    return;
  }
  await saveConfig(config.home, {
    ...base,
    developerId,
    ...(nextName === undefined ? {} : { developerName: nextName }),
  });
};
