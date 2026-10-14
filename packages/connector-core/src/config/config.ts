import { z } from "zod";

import {
  DEFAULT_AGENT_KIND,
  HTTP_TIMEOUT_MS,
  SUMMARIZER_CHILD_ENV,
  SUMMARIZER_CHILD_ON,
} from "../constants.ts";
import { foreignHubOf, resolveKeyBinding } from "./key-binding.ts";
import type { ForeignHub, HubSource } from "./key-binding.ts";
import { hubOrigin, normalizeHubUrl } from "./origin.ts";
import { configPath, crosscheckHome, readJsonOrNull, writePrivateFile } from "./paths.ts";
import type { Env } from "./paths.ts";
import { readRepoConfig } from "./repo-config.ts";
import type { RepoConfig } from "./repo-config.ts";

// Moved to config/origin.ts so the key binding can use them without an
// import cycle; re-exported so every existing import site keeps working.
export { hubOrigin, normalizeHubUrl } from "./origin.ts";

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

/** What a non-string `keyOrigin` parses to: present, and no origin (binds nothing). */
const INVALID_KEY_ORIGIN = "invalid";

export const ConfigSchema = z.looseObject({
  version: z.literal(1),
  hubUrl: z.string().min(1),
  apiKey: z.string().min(1),
  developerId: z.string().min(1).optional(),
  developerName: z.string().min(1).optional(),
  denylist: DenylistSchema.optional(),
  timeoutMs: z.number().int().positive().optional(),
  timeoutSource: z.string().optional().catch(undefined),
  /**
   * The origin `apiKey` was issued for (config/key-binding.ts), written by
   * login. Absent on a login older than the binding, which is bound at its
   * first read (`readBoundStoredConfig`). A value that is present but junk —
   * not a string, or not an origin — binds the key to NO hub rather than
   * falling back to `hubUrl`, so an edit of one field can never move it; the
   * parse itself still succeeds, so the rest of the login survives.
   */
  keyOrigin: z.string().optional().catch(INVALID_KEY_ORIGIN),
});

export type Config = z.infer<typeof ConfigSchema>;

export interface ResolvedConfig {
  readonly home: string;
  readonly hubUrl: string;
  readonly apiKey: string;
  /** The only origin `apiKey` may travel to; null = no hub at all. */
  readonly keyOrigin: string | null;
  /** Where `hubUrl` came from: CROSSCHECK_HUB_URL, the repo, or the login. */
  readonly hubSource: HubSource;
  /**
   * Set when `hubUrl` is not `keyOrigin`. Nothing may be sent then: the
   * reporting surfaces stay out (`resolveReportableConfig`), the human
   * surfaces say so, and the HTTP client refuses the request regardless.
   */
  readonly foreignHub: ForeignHub | null;
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

/**
 * Writes a legacy login's binding back, merged onto the config AS IT IS NOW
 * (the `rememberDeveloper` rule): a `crosscheck login` or `key rotate` that
 * landed since the first read must not be overwritten, so the write happens
 * only while the file still holds the same hub and key and no binding.
 * Exported so the race it guards can be driven directly (key-binding.test.ts).
 */
export const persistLegacyBinding = async (
  home: string,
  read: Config,
  keyOrigin: string,
): Promise<void> => {
  try {
    const current = await readStoredConfig(home);
    const isSameLogin =
      current !== null &&
      current.keyOrigin === undefined &&
      current.hubUrl === read.hubUrl &&
      current.apiKey === read.apiKey;
    if (isSameLogin) {
      await saveConfig(home, { ...current, keyOrigin });
    }
  } catch {
    // Fail-open by design (DESIGN.md §3): a read-only home keeps the binding
    // in memory for this process, and the next read binds the same origin.
  }
};

/**
 * The stored login with its key's binding recorded. A login written before
 * bindings existed carries none: it is bound, at this first read, to the
 * origin of the hub it was logged in to — the only hub it was ever issued
 * for — and that binding is persisted, so a later edit of `hubUrl` can never
 * move the key.
 */
export const readBoundStoredConfig = async (home: string): Promise<Config | null> => {
  const stored = await readStoredConfig(home);
  if (stored === null || stored.keyOrigin !== undefined) {
    return stored;
  }
  const keyOrigin = hubOrigin(stored.hubUrl);
  if (keyOrigin === null) {
    return stored;
  }
  await persistLegacyBinding(home, stored, keyOrigin);
  return { ...stored, keyOrigin };
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

/** The hub a request would go to, and who named it. */
const hubCandidateOf = (
  env: Env,
  repoConfig: RepoConfig | null,
  stored: Config | null,
): { readonly url: string; readonly source: HubSource } | null => {
  const envHub = env["CROSSCHECK_HUB_URL"];
  if (envHub !== undefined) {
    return { url: envHub, source: "env" };
  }
  if (repoConfig !== null) {
    return { url: repoConfig.hubUrl, source: "repo" };
  }
  return stored === null ? null : { url: stored.hubUrl, source: "login" };
};

/**
 * Precedence: env > repo .crosscheck.json (hub URL only) > ~/.crosscheck.
 * Returns null when the connector is not usable — callers then no-op silently.
 *
 * The hub is resolved as it always was; the KEY is resolved with the one
 * origin it is bound to (config/key-binding.ts), and a hub that is not that
 * origin comes back as `foreignHub` rather than as a usable pair.
 */
export const loadConfig = async (
  options: LoadConfigOptions,
): Promise<ResolvedConfig | null> => {
  const { env } = options;
  const home = crosscheckHome(env);
  const stored = await readBoundStoredConfig(home);
  const repoConfig =
    options.repoRoot === undefined ? null : await readRepoConfig(options.repoRoot);

  const hubCandidate = hubCandidateOf(env, repoConfig, stored);
  const binding = resolveKeyBinding(env, stored);
  if (hubCandidate === null || binding === null) {
    return null;
  }
  const hubUrl = normalizeHubUrl(hubCandidate.url);
  if (hubUrl === null) {
    return null;
  }

  return {
    home,
    hubUrl,
    apiKey: binding.apiKey,
    keyOrigin: binding.keyOrigin,
    hubSource: hubCandidate.source,
    foreignHub: foreignHubOf(hubUrl, hubCandidate.source, binding),
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

/**
 * The hub a repo's hooks would be refused for, decided as `loadConfig` decides
 * it — the same hub precedence, the same key binding — but READ-ONLY: a legacy
 * login is bound in memory and never written back. For the one caller that
 * asks on a hook the budget already abandoned, about a repo it never resolved
 * (config/connected-repo.ts connectedRepoOwnership, review batch 2, M2): that
 * path writes nothing it was not asked to. Null when the hub is the key's own,
 * or when there is no hub or no key to compare.
 */
export const foreignHubAt = async (env: Env, repoRoot: string): Promise<ForeignHub | null> => {
  const stored = await readStoredConfig(crosscheckHome(env));
  const hubCandidate = hubCandidateOf(env, await readRepoConfig(repoRoot), stored);
  const binding = resolveKeyBinding(env, stored);
  const hubUrl = hubCandidate === null ? null : normalizeHubUrl(hubCandidate.url);
  return hubCandidate === null || binding === null || hubUrl === null
    ? null
    : foreignHubOf(hubUrl, hubCandidate.source, binding);
};

/**
 * `loadConfig` for the surfaces that REPORT — hooks, capture engines, the
 * MCP tools (finding #11). Under a user-level ("global") install the wiring
 * fires in every directory on the machine, so the §2.1 trust rule must hold
 * here rather than at the wiring: only a repo whose root carries the
 * committed `.crosscheck.json` may be reported to. The stored login's hub
 * URL therefore no longer stands in for a missing repo config on these
 * surfaces — a merely logged-in developer's session in an unconnected repo
 * stays silent forever (connector-claude/test/global-wiring-silence.test.ts
 * pins both directions). CROSSCHECK_HUB_URL keeps standing in: the env
 * override is an operator's explicit per-process instruction, not ambient
 * machine state.
 *
 * Human-run commands (status, doctor, login, privacy) keep plain
 * `loadConfig`: they answer questions about the stored state and report
 * nothing to any hub on a repo's behalf — and they print `foreignHub` when
 * it is set instead of asking a hub the key does not belong to.
 *
 * KEY-ORIGIN BINDING (finding #11 adversarial follow-up, then the Phase 1
 * security review): the hub URL is resolved from the repo's committed
 * `.crosscheck.json`, but that file is shared content — anyone with commit
 * access writes it, and a cloned or forked repo arrives with one. A key may
 * only travel to the ORIGIN it is bound to (config/key-binding.ts), so a repo,
 * a CROSSCHECK_HUB_URL or an unbound CROSSCHECK_API_KEY that would pair it
 * with another origin resolves to `foreign_hub`: nothing is captured, nothing
 * is sent to either hub, and the caller counts the refusal
 * (state/foreign-hub.ts) so it is never silent. The env override is no longer
 * a bypass: it stands in only for its own key's hub.
 */
export type ReportableConfig =
  | { readonly kind: "reportable"; readonly config: ResolvedConfig }
  | { readonly kind: "foreign_hub"; readonly home: string; readonly foreignHub: ForeignHub }
  | { readonly kind: "unreportable" };

const UNREPORTABLE: ReportableConfig = { kind: "unreportable" };

export const resolveReportableConfig = async (
  options: LoadConfigOptions & { readonly repoRoot: string },
): Promise<ReportableConfig> => {
  const config = await loadConfig(options);
  if (config === null) {
    return UNREPORTABLE;
  }
  const hasEnvHub = options.env["CROSSCHECK_HUB_URL"] !== undefined;
  if (hasEnvHub === false && (await readRepoConfig(options.repoRoot)) === null) {
    return UNREPORTABLE;
  }
  if (config.foreignHub !== null) {
    return { kind: "foreign_hub", home: config.home, foreignHub: config.foreignHub };
  }
  return { kind: "reportable", config };
};

/** `resolveReportableConfig` for callers that only need the usable config. */
export const loadReportableConfig = async (
  options: LoadConfigOptions & { readonly repoRoot: string },
): Promise<ResolvedConfig | null> => {
  const resolved = await resolveReportableConfig(options);
  return resolved.kind === "reportable" ? resolved.config : null;
};

export const isDisabled = (env: Env): boolean =>
  env["CROSSCHECK_DISABLED"] === "1";

/**
 * True inside the Tier-1 summarizer's OWN nested `claude -p` (trial finding
 * #14): the runner marks that process's env, and every hook entry that sees
 * the marker exits silently — no hub request, no spool write, no state file,
 * no turn counted — so the summarizer can never register phantom sessions
 * or fire itself again from inside its own model call. A second off-switch
 * beside CROSSCHECK_DISABLED rather than an alias of it, because the two
 * answer different questions ("the developer turned crosscheck off" vs
 * "this process is crosscheck's own child") and a developer reading the env
 * of a stuck process should be able to tell which one fired.
 */
export const isSummarizerChild = (env: Env): boolean =>
  env[SUMMARIZER_CHILD_ENV] === SUMMARIZER_CHILD_ON;

/** Learned identity is written back once, never asked for (spec §A). */
export const rememberDeveloper = async (
  config: ResolvedConfig,
  developerId: string,
  developerName: string | null,
): Promise<void> => {
  if (config.stored === null) {
    return;
  }
  // Merged onto the config AS IT IS NOW, read right before the write: the
  // snapshot this hook started with can be seconds old, and a `crosscheck
  // key rotate` saved in between must not be overwritten by the key it
  // killed.
  const base = await readStoredConfig(config.home);
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
