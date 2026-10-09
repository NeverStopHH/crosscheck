/**
 * WHAT THE LANDED-CHANGE PROBE NEEDS BEFORE IT ASKS ABOUT THE FILE, WITHOUT
 * ASKING GIT EVERY TIME (batch-2 integration review, M6).
 *
 * Every probe used to start with five git spawns that do not depend on the
 * file at all — HEAD and the in-progress markers (`rev-parse`), the landing
 * branches' tips (`for-each-ref`), partial clone (`config`), and the
 * reader's own address (`var`, then `check-mailmap`) — two of them in a row.
 * With the walk itself, about twenty spawns per edit: under load the probe
 * was a third of PreToolUse's whole budget.
 *
 * THE REPO STATE IS READ FROM THE FILES git would read for it: HEAD and the
 * commit its ref names (loose, else `packed-refs` — git/repo-identity.ts),
 * the common dir's `shallow`, and the worktree's MERGE_HEAD and
 * CHERRY_PICK_HEAD. A HEAD the files cannot name (a reftable repository, a
 * ref that names a ref, an unborn branch) is git's to answer, as before.
 *
 * THE REST IS KEPT PER ROOT in `cache/`, with a STAMP of every file and
 * variable its answers depend on: each candidate landing branch's loose ref,
 * `origin/HEAD` and `packed-refs` (git writes a ref by renaming a new file
 * into place, so a fetch is a new inode), the repo, worktree and user git
 * configs, the `.mailmap` text, the team's landing-branch setting, and the
 * author variables. One difference, or an entry older than
 * LANDED_PROBE_FACTS_TTL_MS (an included config, the system config), and git
 * is asked again — the same four questions, unchanged. An environment that
 * steers git, or a reftable repository, is never cached. An answer git could
 * not give (no tips, no address) is never kept.
 *
 * TWO ANSWERS THAT CAN NEVER CHANGE are kept beside them (`ProbeMemo`): a
 * landing branch's tip as it stood when the recent window opened (a commit
 * and an instant name one commit), and a merge base (two commits name one).
 * They are what `tipAt` and `hasNothingNetToUndo` ask on every edit of every
 * file.
 *
 * Fail open throughout: a cache that cannot be read or written is the old
 * probe, never a wrong one.
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { LANDED_PROBE_FACTS_TTL_MS, MAX_LANDED_PROBE_MEMO_ENTRIES } from "../constants.ts";
import { landedProbeFactsCachePath, readJsonOrNull, writePrivateFile } from "../config/paths.ts";
import { commonDirOf, gitDirOf, isReftableGitDir, readHeadFile, resolveHeadCommit } from "../git/repo-identity.ts";
import { fileStamp, gitConfigPaths, isGitSteered } from "../git/repo-identity-cache.ts";
import { isFullSha, isPartialClone, readOwnEmail, readRepoState } from "./git-queries.ts";
import type { GitContext, ProbeMemo, RepoState } from "./git-queries.ts";
import { landingBranchCandidates, landingRefOf, resolveLandingRefs } from "./landing-branches.ts";
import type { LandingBranchesSetting, LandingRef } from "./landing-branches.ts";

const CACHE_VERSION = 1;

/** The variables `git var GIT_AUTHOR_IDENT` reads before any config file, and those that place the user's config. */
const IDENT_ENV = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "EMAIL", "HOME", "XDG_CONFIG_HOME"] as const;

type Env = Readonly<Record<string, string | undefined>>;

/** What the probe asks git about the repo before the file: the landing tips, partial clone, the reader's address. */
export interface ProbeFacts {
  /** Null when git did not answer. */
  readonly refs: readonly LandingRef[] | null;
  readonly isPartial: boolean;
  readonly selfEmail: string | null;
}

export const emptyMemo = (): ProbeMemo => ({ tipAt: new Map(), mergeBase: new Map() });

const MemoEntriesSchema = z.array(z.tuple([z.string(), z.string().nullable()]));

const CacheSchema = z.object({
  version: z.literal(CACHE_VERSION),
  stamp: z.string().nullable(),
  at: z.number(),
  facts: z
    .object({
      refs: z.array(z.object({ branch: z.string().min(1), ref: z.string().min(1), tip: z.string() })),
      isPartial: z.boolean(),
      selfEmail: z.string().min(1),
    })
    .nullable(),
  tipAt: MemoEntriesSchema,
  mergeBase: MemoEntriesSchema,
});

type Cache = z.infer<typeof CacheSchema>;

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

const readMarker = async (path: string): Promise<readonly string[]> =>
  (await readFile(path, "utf8").catch(() => ""))
    .split("\n")
    .map((line) => line.trim())
    .filter(isFullSha);

/**
 * The repo state from the files git reads for `rev-parse
 * --is-shallow-repository HEAD --git-path MERGE_HEAD --git-path
 * CHERRY_PICK_HEAD`; null when the files cannot name HEAD's commit.
 */
export const readRepoStateFromFiles = async (root: string): Promise<RepoState | null> => {
  const head = await readHeadFile(root);
  if (head === null) {
    return null;
  }
  const [headSha, commonDir] = await Promise.all([resolveHeadCommit(head), commonDirOf(head.gitDir)]);
  if (headSha === null) {
    return null;
  }
  const [isShallow, mergeHeads, picked] = await Promise.all([
    exists(join(commonDir, "shallow")),
    readMarker(join(head.gitDir, "MERGE_HEAD")),
    readMarker(join(head.gitDir, "CHERRY_PICK_HEAD")),
  ]);
  return { isShallow, headSha, mergeHeads, pickedSha: picked[0] ?? null };
};

/** The repo state: from the files when they can name it, else git's own answer. */
export const readProbeRepoState = async (context: GitContext): Promise<RepoState | null> =>
  (await readRepoStateFromFiles(context.root).catch(() => null)) ?? readRepoState(context);

/** The stamp of everything the facts depend on, or null when the files cannot vouch for them. */
const stampOf = async (root: string, setting: LandingBranchesSetting, mailmap: string, env: Env): Promise<string | null> => {
  const gitDir = await gitDirOf(root);
  if (gitDir === null || isGitSteered(env) || (await isReftableGitDir(gitDir))) {
    return null;
  }
  const commonDir = await commonDirOf(gitDir);
  const refFiles = [landingRefOf("HEAD"), ...landingBranchCandidates(setting).map(landingRefOf)].map((ref) =>
    join(commonDir, ref),
  );
  const stamps = await Promise.all(
    [...refFiles, join(commonDir, "packed-refs"), ...gitConfigPaths(gitDir, commonDir, env)].map(fileStamp),
  );
  return JSON.stringify([
    root,
    gitDir,
    JSON.stringify(setting),
    createHash("sha256").update(mailmap).digest("hex"),
    ...IDENT_ENV.map((name) => env[name] ?? ""),
    ...stamps,
  ]);
};

const readCache = async (home: string, root: string): Promise<Cache | null> => {
  const parsed = CacheSchema.safeParse(await readJsonOrNull(landedProbeFactsCachePath(home, root)));
  return parsed.success ? parsed.data : null;
};

/** The newest MAX_LANDED_PROBE_MEMO_ENTRIES of a memo map, oldest first. */
const bounded = (entries: ReadonlyMap<string, string | null>): [string, string | null][] =>
  [...entries].slice(-MAX_LANDED_PROBE_MEMO_ENTRIES);

const writeCache = async (home: string, root: string, cache: Cache): Promise<void> => {
  await writePrivateFile(landedProbeFactsCachePath(home, root), `${JSON.stringify(cache)}\n`).catch(() => undefined);
};

/** One probe's view of the cache: the facts, and how to keep what its memo learned. */
export interface ProbeFactsSession {
  readonly facts: ProbeFacts;
  /** Writes the memo back when this probe added to it; never throws. */
  readonly keep: () => Promise<void>;
}

export interface ProbeFactsInput {
  readonly root: string;
  readonly setting: LandingBranchesSetting;
  readonly mailmap: string;
  readonly context: GitContext;
  readonly timeoutMs: number;
  /** Where the cache lives; null asks git every time and keeps nothing. */
  readonly home: string | null;
  readonly now: Date;
  /** The probe's memo, filled here with what the root kept. */
  readonly memo: ProbeMemo;
  /** The environment git runs under. Default: this process's, which git/git.ts hands git whole. */
  readonly env?: Env;
}

const askGit = async (input: ProbeFactsInput): Promise<ProbeFacts> => {
  const [refs, isPartial, selfEmail] = await Promise.all([
    resolveLandingRefs(input.root, input.setting, input.timeoutMs),
    isPartialClone(input.context),
    readOwnEmail(input.context),
  ]);
  return { refs, isPartial, selfEmail };
};

/** The facts as the cache keeps them, or null for an answer git could not give. */
const keepable = (facts: ProbeFacts): Cache["facts"] =>
  facts.refs === null || facts.selfEmail === null
    ? null
    : { refs: [...facts.refs], isPartial: facts.isPartial, selfEmail: facts.selfEmail };

const NO_KEEPING = async (): Promise<void> => undefined;

/**
 * The facts for this probe — the cache's while its stamp holds, else git's —
 * with the root's never-changing answers loaded into the probe's memo.
 */
export const openProbeFacts = async (input: ProbeFactsInput): Promise<ProbeFactsSession> => {
  const { home, memo } = input;
  if (home === null) {
    return { facts: await askGit(input), keep: NO_KEEPING };
  }
  const nowMs = input.now.getTime();
  const [cached, stamp] = await Promise.all([
    readCache(home, input.root).catch(() => null),
    stampOf(input.root, input.setting, input.mailmap, input.env ?? process.env).catch(() => null),
  ]);
  const ageMs = cached === null ? Number.NaN : nowMs - cached.at;
  const fresh =
    cached !== null && stamp !== null && cached.stamp === stamp && ageMs >= 0 && ageMs < LANDED_PROBE_FACTS_TTL_MS
      ? cached.facts
      : null;
  const facts = fresh ?? (await askGit(input));
  const kept = fresh === null ? keepable(facts) : fresh;
  const base: Cache = {
    version: CACHE_VERSION,
    stamp: kept === null ? null : stamp,
    at: fresh === null ? nowMs : (cached?.at ?? nowMs),
    facts: kept,
    tipAt: cached?.tipAt ?? [],
    mergeBase: cached?.mergeBase ?? [],
  };
  if (fresh === null && kept !== null && stamp !== null) {
    await writeCache(home, input.root, base);
  }
  for (const [key, value] of base.tipAt) {
    memo.tipAt.set(key, value);
  }
  for (const [key, value] of base.mergeBase) {
    memo.mergeBase.set(key, value);
  }
  const known = { tipAt: memo.tipAt.size, mergeBase: memo.mergeBase.size };
  const keep = async (): Promise<void> => {
    if (memo.tipAt.size === known.tipAt && memo.mergeBase.size === known.mergeBase) {
      return;
    }
    await writeCache(home, input.root, { ...base, tipAt: bounded(memo.tipAt), mergeBase: bounded(memo.mergeBase) });
  };
  return { facts, keep };
};
