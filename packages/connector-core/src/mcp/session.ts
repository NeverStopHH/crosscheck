/**
 * Which of the developer's own work contexts an MCP tool writes to.
 *
 * A hook is HANDED its session id on stdin (`hooks/runner.ts` parses it out of
 * the payload). An MCP server is not: Claude Code starts one per project and
 * never says which session is calling it. The only evidence on the machine is
 * the session state files SessionStart writes before its first append
 * (state/session-state.ts), so this reads them and picks.
 *
 * THE RULE, in order:
 *   1. the hub must match — the same repo on two hubs is two trust spaces
 *      (config/paths.ts `repoKey` scopes by hub for the same reason), and a
 *      claim published into the wrong one is not recoverable from here;
 *   2. the repo must match;
 *   3. the WORKTREE ROOT is preferred over recency, because two worktrees of one
 *      repo share a repoId and are genuinely different pieces of work — the
 *      sibling being newer is the ordinary case, not the exception;
 *   4. only then, newest `startedAt` wins.
 *
 * WHAT THIS CANNOT DO. Two agent sessions in the SAME worktree against the same
 * hub are indistinguishable from in here, and the newest one is chosen. That is
 * a limitation, not a correct answer, and it is asserted as one in
 * test/mcp-session.test.ts so it stays tracked. The fix is not local: it needs
 * Claude Code to pass a session id to MCP servers the way it does to hooks.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { readJsonOrNull } from "../config/paths.ts";
import { realpathBestEffort } from "../config/paths.ts";
import { SessionStateSchema } from "../state/session-state.ts";
import type { SessionState } from "../state/session-state.ts";
import type { RepoIdentity } from "../git/repo-identity.ts";

export interface OwnWorkContext {
  readonly claudeSessionId: string;
  readonly crosscheckSessionId: string;
  readonly workContextId: string;
  /**
   * Who the hub will check the producer against.
   *
   * `/api/records` rejects any envelope whose `producer.developerId` is not the
   * authenticated developer (services/records.ts `ingestOne`). A hook does not
   * have to care — `withProducer` rewrites the id at flush time
   * (capture/records.ts) — but a tool posts directly and has no flush, so it
   * must know who it is first. SessionStart wrote it here, and on a machine
   * whose ~/.crosscheck/config.json has not yet learned a developerId this file
   * is the only place that has one.
   */
  readonly developerId: string | null;
}

/**
 * Every session state file that parses, with the unparseable ones dropped.
 *
 * Dropped rather than fatal: a half-written file from a crashed hook must not
 * make every `publish_claim` in the repo fail. Unlike the diagnosis renderer,
 * nothing is counted here — a state file this process cannot read belongs to a
 * session it could not have written to anyway, so there is no degraded result to
 * report, only a candidate that was never eligible.
 */
const readSessionStates = async (
  home: string,
): Promise<readonly SessionState[]> => {
  let names: readonly string[];
  try {
    names = await readdir(join(home, "sessions"));
  } catch {
    return [];
  }
  const parsed = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) =>
        SessionStateSchema.safeParse(
          await readJsonOrNull(join(home, "sessions", name)),
        ),
      ),
  );
  return parsed.filter((entry) => entry.success).map((entry) => entry.data);
};

/** Newest first, by the time SessionStart recorded. */
const byNewest = (left: SessionState, right: SessionState): number =>
  Date.parse(right.startedAt) - Date.parse(left.startedAt);

export const resolveOwnWorkContext = async (
  home: string,
  identity: RepoIdentity,
  hubUrl: string,
): Promise<OwnWorkContext | null> => {
  const states = await readSessionStates(home);
  const eligible = states
    .filter((state) => state.hubUrl === hubUrl && state.repoId === identity.repoId)
    .sort(byNewest);
  if (eligible.length === 0) {
    return null;
  }
  // Symlinked checkouts (/var vs /private/var on macOS) otherwise make the same
  // worktree look like two — the same reason repo-identity resolves real paths.
  const here = await realpathBestEffort(identity.root);
  const sameRoot = await Promise.all(
    eligible.map(async (state) => (await realpathBestEffort(state.repoRoot)) === here),
  );
  const chosen =
    eligible.find((_state, index) => sameRoot[index] === true) ?? eligible[0];
  if (chosen === undefined) {
    return null;
  }
  return {
    claudeSessionId: chosen.claudeSessionId,
    crosscheckSessionId: chosen.crosscheckSessionId,
    workContextId: chosen.workContextId,
    developerId: chosen.developerId,
  };
};
