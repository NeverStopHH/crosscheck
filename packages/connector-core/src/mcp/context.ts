/**
 * Everything an MCP tool needs, or the reason it has nothing.
 *
 * THIS IS THE OPPOSITE TRADE FROM `prepareHook`. That one returns `null` for
 * every unusable state and the hook exits silently, because a hook runs inside a
 * developer's keystroke and DESIGN.md §3 makes it fail open. A tool call is the
 * reverse on every axis: the agent asked for it, it is waiting for the answer,
 * and a silent no-op teaches a model that the tools do not work. So every
 * unusable state carries a sentence the caller can act on.
 *
 * Resolved PER CALL rather than once at startup. An MCP server outlives the
 * `crosscheck login` that fixes it, and a server that cached "no api key" at
 * launch would keep saying so for the rest of the session.
 */
import { MCP_TIMEOUT_MS } from "../constants.ts";
import { isDisabled, loadConfig, loadReportableConfig } from "../config/config.ts";
import type { ResolvedConfig } from "../config/config.ts";
import { repoKey } from "../config/paths.ts";
import type { Env } from "../config/paths.ts";
import { resolveRepoIdentity } from "../git/repo-identity.ts";
import type { RepoIdentity } from "../git/repo-identity.ts";
import type { HubContext } from "../http/client.ts";

export interface McpContext {
  readonly config: ResolvedConfig;
  readonly identity: RepoIdentity;
  readonly hub: HubContext;
  readonly repoKey: string;
  readonly now: () => Date;
}

export type McpSetup =
  | { readonly ok: true; readonly ctx: McpContext }
  | { readonly ok: false; readonly message: string };

export const prepareMcp = async (env: Env, cwd: string): Promise<McpSetup> => {
  if (isDisabled(env)) {
    return {
      ok: false,
      message:
        "crosscheck is disabled here because CROSSCHECK_DISABLED=1 is set. " +
        "Unset it and restart the session to use these tools.",
    };
  }
  const identity = await resolveRepoIdentity(cwd);
  if (identity === null) {
    return {
      ok: false,
      message:
        `${cwd} is not a git repository, so crosscheck cannot tell which repo this is. ` +
        "These tools identify work by git remote and only run inside a checkout.",
    };
  }
  // The finding-#11 gate, with the honest sentence a tool call deserves:
  // under a user-scope MCP registration the tools exist in EVERY repo, and
  // an unconnected one must answer with the reason and the remedy — never a
  // crash, never a report to a hub this repo never opted into (§2.1). The
  // two states are told apart so the remedy is the right one: no
  // credentials at all vs. credentials without the committed repo config.
  const config = await loadReportableConfig({ env, repoRoot: identity.root });
  if (config === null) {
    const hasCredentials =
      (await loadConfig({ env, repoRoot: identity.root })) !== null;
    return {
      ok: false,
      message: hasCredentials
        ? `${identity.root} is not connected to a hub: it has no committed ` +
          ".crosscheck.json, and only connected repos ever report. Run " +
          "crosscheck init in this repo to connect it (the file is meant to " +
          "be committed), then restart the session."
        : "crosscheck has no hub url or api key for this repo. Run " +
          "crosscheck login with your hub url and then crosscheck init, then restart " +
          "the session. crosscheck doctor says which of the two is missing.",
    };
  }
  const now = (): Date => new Date();
  const key = repoKey(config.hubUrl, identity.repoId);
  return {
    ok: true,
    ctx: {
      config,
      identity,
      repoKey: key,
      now,
      hub: {
        hubUrl: config.hubUrl,
        apiKey: config.apiKey,
        timeoutMs: MCP_TIMEOUT_MS,
        home: config.home,
        repoKey: key,
        now,
      },
    },
  };
};
