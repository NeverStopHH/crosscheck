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
  readonly hostSessionKey: string;
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
  /**
   * The title and status this session registered with (state/session-state.ts,
   * trial finding #16): `set_intent` posts a work_context UPDATE, and the wire
   * schema requires both. Null on a state file from before intent support —
   * the tool then says so rather than fabricating a title.
   */
  readonly workContextTitle: string | null;
  readonly workContextStatus: string | null;
  readonly startedAt: string;
  /**
   * THE PICK WAS A COIN FLIP (spec 01 §10 D1). True when more than one
   * eligible state file matched this worktree root, or — when no root matched
   * at all — when more than one session was eligible. The rule above still
   * returns its deterministic answer; this says the answer is not evidence.
   *
   * Every MCP writer reads it and REFUSES THE POSITION, not the record: the
   * claim or intent lands carrying `allocation_failed`, and only its place in
   * the session's order is withheld. `set_intent` is exactly the call AT-4
   * hangs on, so stamping the guess would let "did the amendment precede the
   * edit" be answered confidently from a coin flip — and an amendment filed
   * into ANOTHER session's order is worse than one filed into none.
   *
   * ONE BOUNDED BOOLEAN, not a list of candidates: nothing downstream may act
   * on WHICH sessions collided, only on the fact that they did.
   */
  readonly sessionAmbiguous: boolean;
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
  // Counted at the PICK, where the evidence is, and nowhere else: two matches
  // on this root means the root could not separate them, and zero matches with
  // several candidates means the fall-through to newest-started is choosing
  // between strangers. One match, or one candidate, is not a guess.
  const rootMatches = sameRoot.filter(Boolean).length;
  const sessionAmbiguous =
    rootMatches > 1 || (rootMatches === 0 && eligible.length > 1);
  return {
    hostSessionKey: chosen.hostSessionKey,
    crosscheckSessionId: chosen.crosscheckSessionId,
    workContextId: chosen.workContextId,
    developerId: chosen.developerId,
    workContextTitle: chosen.workContextTitle,
    workContextStatus: chosen.workContextStatus,
    startedAt: chosen.startedAt,
    sessionAmbiguous,
  };
};
