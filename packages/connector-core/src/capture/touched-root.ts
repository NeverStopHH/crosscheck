/**
 * Which repo root governs a TOUCHED file (trial finding #17).
 *
 * The bug this fixes: capture bound `state.repoRoot` at SessionStart and fed
 * it to `toRepoRelative` for every later edit. An edit inside a LINKED GIT
 * WORKTREE of the same repo — a session registered at checkout A editing a
 * file in worktree B — is outside A, so `toRepoRelative` returned null and the
 * target was silently dropped: 371 worktree edits → 0 targets across the trial
 * (A1/transcript-tool-histogram.tsv), and the only drop counter compared
 * repoId (identical across worktrees of one repo), so nothing was even
 * counted.
 *
 * The fix, per path: resolve the repo-relative id against the root that
 * governs the FILE, accepted only when that root's repoId equals the session's.
 *
 *   (a) FAST PATH — the file resolves under the session root already
 *       (`toRepoRelative(sessionRoot, cwd, path)` non-null): today's zero-cost
 *       answer, the common in-checkout case, no git.
 *   (b) else a CANDIDATE root: the runner already resolved the CWD's identity,
 *       so when `ctx.identity.root` differs from the session root and carries
 *       the same repoId (the "cwd is inside the worktree" shape, D2), it IS
 *       the file's root — free, no git. Otherwise walk up from the file to its
 *       own connected root (`findConnectedRepoRootForFile`, fs-only, bounded).
 *   (c) the candidate's repoId, from the session-state cache
 *       (`knownWorktreeRoots`, positive AND negative answers) or ONE bounded
 *       `resolveRepoIdentity` on a cache miss — never per tool call for a root
 *       already seen (hook budgets are binding).
 *   (d) same repoId → capture against the candidate; a DIFFERENT repoId → a
 *       foreign drop (counted, the first-wins rule); a candidate that still
 *       will not resolve, or none at all → an outside-root drop (counted).
 *
 * PURE over injected primitives so the hook drives it once (a pre-pass) and
 * folds the counts, the cache additions and the #18 diagnosis root into its
 * one locked state write. ACP/Cursor do not call this — the capture flow keeps
 * its single-root default (their worktree parity is a follow-up).
 */
import { findConnectedRepoRootForFile } from "../config/connected-repo.ts";
import { realpathBestEffort } from "../config/paths.ts";
import { resolveRepoIdentity } from "../git/repo-identity.ts";
import { toRepoRelative } from "./target-paths.ts";

export interface KnownWorktreeRoot {
  /** A realpath'd worktree root. */
  readonly root: string;
  /** Its repo id, or null — the NEGATIVE answer (foreign or unresolvable). */
  readonly repoId: string | null;
}

export interface ResolveTouchedRootsInput {
  readonly paths: readonly string[];
  readonly cwd: string;
  readonly sessionRepoRoot: string;
  readonly sessionRepoId: string;
  /**
   * `ctx.identity.root` / `ctx.identity.repoId` — the CWD's already-resolved
   * identity, reused free for the D2 (cwd-in-worktree) shape.
   */
  readonly identityRoot: string;
  readonly identityRepoId: string;
  /** The session-state cache (realpath-keyed), read at the call's start. */
  readonly knownWorktreeRoots: readonly KnownWorktreeRoot[];
  /**
   * Seams (real by default): the connected-root walk, the bounded identity
   * resolution, and realpath. Injected only so a unit test can be
   * deterministic without spawning git.
   */
  readonly resolveConnectedRoot?: (
    cwd: string,
    path: string,
  ) => Promise<string | null>;
  readonly resolveRootRepoId?: (root: string) => Promise<string | null>;
  readonly realpath?: (path: string) => Promise<string>;
}

export interface TouchedRootsResolution {
  /** path (as given) → the root to derive its repo-relative id against. */
  readonly rootByPath: ReadonlyMap<string, string>;
  /** Touches of a DIFFERENT connected repo (first-wins). */
  readonly foreignDrops: number;
  /** Touches that resolved to no root of THIS session's repo. */
  readonly outsideDrops: number;
  /** New realpath'd (root → repoId|null) answers to fold into the cache. */
  readonly newlyResolved: readonly KnownWorktreeRoot[];
  /**
   * The root the FIRST path resolved against, or null when it dropped — the
   * #18 diagnosis line's "last edited path resolved: yes|no (against <root>)".
   */
  readonly firstResolvedRoot: string | null;
}

const defaultResolveRootRepoId = async (
  root: string,
): Promise<string | null> => {
  const identity = await resolveRepoIdentity(root);
  return identity?.repoId ?? null;
};

export const resolveTouchedRoots = async (
  input: ResolveTouchedRootsInput,
): Promise<TouchedRootsResolution> => {
  const resolveConnectedRoot =
    input.resolveConnectedRoot ?? findConnectedRepoRootForFile;
  const resolveRootRepoId =
    input.resolveRootRepoId ?? defaultResolveRootRepoId;
  const realpath = input.realpath ?? realpathBestEffort;

  const sessionRootReal = await realpath(input.sessionRepoRoot);
  const identityRootReal = await realpath(input.identityRoot);

  // The cache, realpath-keyed, seeded from session state and grown in place so
  // two paths sharing a new worktree root cost identity resolution only once.
  const cache = new Map<string, string | null>(
    input.knownWorktreeRoots.map((entry) => [entry.root, entry.repoId]),
  );
  const newlyResolved: KnownWorktreeRoot[] = [];

  const rootByPath = new Map<string, string>();
  let foreignDrops = 0;
  let outsideDrops = 0;
  let firstResolvedRoot: string | null = null;

  for (let index = 0; index < input.paths.length; index += 1) {
    const path = input.paths[index] as string;
    const isFirst = index === 0;

    // (a) already inside the session checkout — no git, the common case.
    const fast = await toRepoRelative(input.sessionRepoRoot, input.cwd, path);
    if (fast !== null) {
      rootByPath.set(path, input.sessionRepoRoot);
      if (isFirst) {
        firstResolvedRoot = input.sessionRepoRoot;
      }
      continue;
    }

    // (b) the file's own root: the CWD's identity when it is a DIFFERENT root
    // of the same repo (D2, free), else a bounded fs walk up from the file.
    const candidate =
      identityRootReal !== sessionRootReal &&
      input.identityRepoId === input.sessionRepoId
        ? input.identityRoot
        : await resolveConnectedRoot(input.cwd, path);
    if (candidate === null) {
      outsideDrops += 1;
      continue;
    }

    // (c) the candidate's repoId — cache, then identity resolution once. The
    // D2 identity candidate already knows its repoId, so it too costs no git.
    const candidateReal = await realpath(candidate);
    let repoId = cache.get(candidateReal);
    if (repoId === undefined) {
      repoId =
        candidateReal === identityRootReal
          ? input.identityRepoId
          : await resolveRootRepoId(candidate);
      cache.set(candidateReal, repoId);
      newlyResolved.push({ root: candidateReal, repoId });
    }

    // (d) same repo → capture; different → foreign; unresolvable → outside.
    if (repoId === input.sessionRepoId) {
      const relative = await toRepoRelative(candidate, input.cwd, path);
      if (relative !== null) {
        rootByPath.set(path, candidate);
        if (isFirst) {
          firstResolvedRoot = candidate;
        }
        continue;
      }
      outsideDrops += 1;
      continue;
    }
    foreignDrops += 1;
  }

  return {
    rootByPath,
    foreignDrops,
    outsideDrops,
    newlyResolved,
    firstResolvedRoot,
  };
};
