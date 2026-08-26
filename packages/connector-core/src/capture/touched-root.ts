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
 *       the same repoId (the "cwd is inside the worktree" shape, D2), it is a
 *       FREE candidate — but only for the paths it actually contains. It is
 *       the CWD's root, not the file's: a payload whose cwd sits in worktree B
 *       while the edited file lives in worktree C is governed by C, so the
 *       identity candidate is taken only when `toRepoRelative` against it
 *       succeeds, and otherwise falls through to the walk up from the file to
 *       its own connected root (`findConnectedRepoRootForFile`, fs-only,
 *       bounded). Skipping that fall-through dropped same-repo targets and
 *       booked cross-repo touches as outside-root drops.
 *   (c) the candidate's repoId, from the session-state cache
 *       (`knownWorktreeRoots`, positive AND negative answers) or ONE bounded
 *       `resolveRepoIdentity` on a cache miss — never per tool call for a root
 *       already seen (hook budgets are binding). A cached NULL is an UNKNOWN,
 *       not an answer: a git deadline missed once under load would otherwise
 *       exile that worktree for the session's whole life, so a null is
 *       re-resolved until MAX_WORKTREE_ROOT_RESOLVE_ATTEMPTS tries have been
 *       spent on it, then stands (the budget needs a floor too). A POSITIVE
 *       answer is not final either, because the key is only a directory path:
 *       every entry carries the `stamp` of the checkout it was read from, and
 *       a path whose checkout has been REPLACED — the fixed-path worktree
 *       convention, `git worktree remove` then `git worktree add` from another
 *       repo — is judged again. Without that the second repo's files were
 *       captured under the first repo's key with both drop counters at 0.
 *   (d) same repoId → capture against the candidate; a DIFFERENT repoId → a
 *       foreign drop (counted, the first-wins rule); a candidate whose repoId
 *       is UNKNOWN, one that still will not resolve, or none at all → an
 *       outside-root drop (counted). An unresolvable root is not evidence of a
 *       second repo, so it must never inflate the foreign count that doctor
 *       explains as "a multi-repo workspace's touches of its second repo".
 *
 * PURE over injected primitives so the caller drives it once (a pre-pass) and
 * folds the counts, the cache additions and the #18 diagnosis root into its
 * one locked state write.
 *
 * EVERY CONNECTOR CALLS THIS, and that is a claim rather than a hope. It was
 * once true that only the Claude hooks did — Cursor and ACP kept the capture
 * flow's single-root default and so lost every edit made in a linked worktree,
 * uncounted, on hosts nobody was measuring. The join is now one shared flow
 * (flows/capture-touched-files.ts), and its callers are pinned below: a fourth
 * connector that captures without it shows up as a line this claim did not
 * predict, which is a stronger tripwire than a count that stays at zero
 * because the new site was never counted. The flow itself carries the mirror
 * directive — that nothing else constructs a raw `captureFileTargets` call.
 *
 * The one caller here that is NOT a capture site is the Claude PreToolUse
 * tripwire (hooks/pre-tool-use.ts), which resolves the first edited path's
 * root to ask the hub about it and deliberately books no drop counters: the
 * tripwire is not a capture path, and double-counting a path PostToolUse will
 * also see would corrupt the very ratio the doctor WARN is measured on.
 *
 * The directive lives in line comments because the glob it needs would end a
 * block comment mid-word, and it spells the open paren as a bracket
 * expression so the claim does not match ITSELF and report this file as a
 * fourth connector.
 */
// VERIFY: grep -rl --include='*.ts' 'captureTouchedFiles[(]{' packages/*/src | sort
// PRINTS: packages/connector-acp/src/capture/engine.ts
// PRINTS: packages/connector-claude/src/hooks/post-tool-use.ts
// PRINTS: packages/connector-cursor/src/handlers/file-edit.ts
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { MAX_WORKTREE_ROOT_RESOLVE_ATTEMPTS } from "../constants.ts";
import {
  GIT_ENTRY_NAME,
  findConnectedRepoRootForFile,
} from "../config/connected-repo.ts";
import { realpathBestEffort } from "../config/paths.ts";
import { resolveRepoIdentity } from "../git/repo-identity.ts";
import { toRepoRelative } from "./target-paths.ts";

export interface KnownWorktreeRoot {
  /** A realpath'd worktree root. */
  readonly root: string;
  /**
   * Its repo id — a foreign root carries ITS id (≠ the session's); an
   * unresolvable root is null, which is an UNKNOWN rather than an answer.
   */
  readonly repoId: string | null;
  /**
   * Identity resolutions this session has already spent on the root. Only a
   * null `repoId` reads it: a known id is final, an unknown is retried while
   * this is below MAX_WORKTREE_ROOT_RESOLVE_ATTEMPTS.
   */
  readonly attempts: number;
  /**
   * WHICH CHECKOUT the answer above was read from — `dev:ino:birthtime` of the
   * root's `.git` entry. Without it a positive answer stood forever against a
   * key that is only a directory PATH, and a fixed-path worktree convention
   * (`~/worktrees/feature`) torn down and stood up again from a DIFFERENT repo
   * inherited the first repo's id: the second repo's files were spooled into
   * the first repo's work context under repo-relative ids, with both drop
   * counters reading 0.
   *
   * Deliberately not the mtime: a main checkout's `.git` DIRECTORY changes
   * mtime on every commit, which would re-spend git on a root already judged
   * and break the budget the cache exists to hold. `dev:ino:birthtime` is
   * stable across commits and changes when the entry is recreated.
   *
   * Null is "unknowable", never "different": an entry from a state file
   * written before this field existed, and a `.git` that could not be stat'd.
   * Only a stamp that is known AND different invalidates, so the cache can
   * never start paying git per touch because a stat is failing.
   */
  readonly stamp: string | null;
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
  /** Reads a root's checkout stamp; see `KnownWorktreeRoot.stamp`. */
  readonly readRootStamp?: (root: string) => Promise<string | null>;
}

export interface TouchedRootsResolution {
  /** path (as given) → the root to derive its repo-relative id against. */
  readonly rootByPath: ReadonlyMap<string, string>;
  /** Touches of a DIFFERENT connected repo (first-wins). */
  readonly foreignDrops: number;
  /** Touches that resolved to no root of THIS session's repo. */
  readonly outsideDrops: number;
  /**
   * New realpath'd (root → repoId|null) answers to fold into the cache, each
   * with the attempts spent on it so a retried UNKNOWN keeps its budget.
   */
  readonly newlyResolved: readonly KnownWorktreeRoot[];
  /**
   * The root the FIRST path resolved against, or null when it dropped — the
   * #18 diagnosis line's "last edited path resolved: yes|no (against <root>)".
   */
  readonly firstResolvedRoot: string | null;
}

interface CacheEntry {
  readonly repoId: string | null;
  readonly attempts: number;
  readonly stamp: string | null;
}

/** A null repoId stands only once the attempt budget for it is spent. */
const isRetryableUnknown = (entry: CacheEntry): boolean =>
  entry.repoId === null && entry.attempts < MAX_WORKTREE_ROOT_RESOLVE_ATTEMPTS;

/**
 * A cached answer belongs to the checkout it was read from. Only a stamp that
 * is KNOWN on both sides and differs is evidence that the directory now holds
 * a different checkout; anything unknowable leaves the answer standing, so a
 * failing stat can never turn the cache into a git call per touch.
 */
const isDifferentCheckout = (
  entry: CacheEntry,
  stamp: string | null,
): boolean => entry.stamp !== null && stamp !== null && entry.stamp !== stamp;

const defaultResolveRootRepoId = async (
  root: string,
): Promise<string | null> => {
  const identity = await resolveRepoIdentity(root);
  return identity?.repoId ?? null;
};

/**
 * `dev:ino:birthtime` of the root's `.git` entry — a file for a linked
 * worktree, a directory for a main checkout, and recreated by `git worktree
 * add` either way. One `stat`, paid only on the slow path (a touch that is
 * already outside the session checkout), never on the fast path.
 */
const defaultReadRootStamp = async (root: string): Promise<string | null> => {
  const stats = await stat(join(root, GIT_ENTRY_NAME)).catch(() => null);
  return stats === null
    ? null
    : `${String(stats.dev)}:${String(stats.ino)}:${String(stats.birthtimeMs)}`;
};

export const resolveTouchedRoots = async (
  input: ResolveTouchedRootsInput,
): Promise<TouchedRootsResolution> => {
  const resolveConnectedRoot =
    input.resolveConnectedRoot ?? findConnectedRepoRootForFile;
  const resolveRootRepoId =
    input.resolveRootRepoId ?? defaultResolveRootRepoId;
  const realpath = input.realpath ?? realpathBestEffort;
  const readRootStamp = input.readRootStamp ?? defaultReadRootStamp;

  const sessionRootReal = await realpath(input.sessionRepoRoot);
  const identityRootReal = await realpath(input.identityRoot);

  // The cache, realpath-keyed, seeded from session state and grown in place so
  // two paths sharing a new worktree root cost identity resolution only once.
  const cache = new Map<string, CacheEntry>(
    input.knownWorktreeRoots.map((entry) => [
      entry.root,
      { repoId: entry.repoId, attempts: entry.attempts, stamp: entry.stamp },
    ]),
  );
  const newlyResolved: KnownWorktreeRoot[] = [];

  // The D2 shape, judged ONCE: the cwd sits in a different checkout of this
  // session's repo. Per path it is still only a candidate — see (b).
  const identityIsSiblingRoot =
    identityRootReal !== sessionRootReal &&
    input.identityRepoId === input.sessionRepoId;

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

    // (b) the file's own root. The CWD's identity is free, but it governs only
    // the paths it CONTAINS: a cwd in worktree B says nothing about a file in
    // worktree C, so a miss falls through to the walk instead of giving up.
    const viaIdentity = identityIsSiblingRoot
      ? await toRepoRelative(input.identityRoot, input.cwd, path)
      : null;
    const candidate =
      viaIdentity !== null
        ? input.identityRoot
        : await resolveConnectedRoot(input.cwd, path);
    if (candidate === null) {
      outsideDrops += 1;
      continue;
    }

    // (c) the candidate's repoId — cache, then identity resolution once. The
    // D2 identity candidate already knows its repoId, so it too costs no git.
    const candidateReal = await realpath(candidate);
    const cached = cache.get(candidateReal);
    // WHICH CHECKOUT is at that path now. One `stat`, and only here — the
    // fast path (a) never reaches this, so an in-checkout edit pays nothing.
    const stamp = await readRootStamp(candidateReal);
    const replaced = cached !== undefined && isDifferentCheckout(cached, stamp);
    let repoId: string | null;
    if (cached !== undefined && !replaced && !isRetryableUnknown(cached)) {
      repoId = cached.repoId;
      // An answer from a state file written before stamps existed is accepted
      // once and BOUND from now on: the first touch after an upgrade behaves
      // exactly as it always did, every later one is protected, and no git is
      // spent to get there.
      if (cached.stamp === null && stamp !== null) {
        const bound = { repoId, attempts: cached.attempts, stamp };
        cache.set(candidateReal, bound);
        newlyResolved.push({ root: candidateReal, ...bound });
      }
    } else {
      repoId =
        candidateReal === identityRootReal
          ? input.identityRepoId
          : await resolveRootRepoId(candidate);
      // A REPLACED checkout starts its own attempt budget: what the previous
      // directory at this path spent says nothing about this one.
      const attempts = replaced ? 1 : (cached?.attempts ?? 0) + 1;
      const answer = { repoId, attempts, stamp };
      cache.set(candidateReal, answer);
      newlyResolved.push({ root: candidateReal, ...answer });
    }

    // (d) unknown → outside (an UNKNOWN is not a second repo); a different
    // repo → foreign; same repo → capture, or outside when it will not
    // resolve against its own root either.
    if (repoId === null) {
      outsideDrops += 1;
      continue;
    }
    if (repoId !== input.sessionRepoId) {
      foreignDrops += 1;
      continue;
    }
    const relative =
      viaIdentity ?? (await toRepoRelative(candidate, input.cwd, path));
    if (relative === null) {
      outsideDrops += 1;
      continue;
    }
    rootByPath.set(path, candidate);
    if (isFirst) {
      firstResolvedRoot = candidate;
    }
  }

  return {
    rootByPath,
    foreignDrops,
    outsideDrops,
    newlyResolved,
    firstResolvedRoot,
  };
};
