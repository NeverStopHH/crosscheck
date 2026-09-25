/**
 * THE BACKGROUND FETCH OF THE LANDING BRANCHES (docs/1.0/landed-changes.md,
 * step 2): the detached worker's logic. A hook books the attempt and starts
 * it (fetch-trigger.ts); nothing ever waits for it.
 *
 * It exists because git only knows what the clone has fetched. The pre-edit
 * stop asks the reader's own clone, so a teammate's change merged after the
 * reader's last `git fetch` is invisible to it — the most common sequential
 * conflict of all.
 *
 * WHAT IT WRITES: `refs/remotes/origin/<landing branch>` (and the objects
 * they need), nothing else.
 * - What is fetched is every branch the STOP reads now (its rule applied to
 *   the clone's own refs) plus what the same rule picks on origin, each only
 *   while origin has it — so a branch the stop watches stays fresh even when
 *   origin's default branch has moved since this clone was made.
 * - Origin is asked first (`ls-remote`, one round trip) about all of those
 *   names: an explicit refspec for a branch origin lacks fails the whole
 *   fetch, and one mistyped name in `.crosscheck.json` would then cost every
 *   branch.
 * - `--refmap=`: without it git ALSO applies every configured
 *   `remote.origin.fetch` refspec to what it fetches ("opportunistic
 *   updates"), and one such refspec can name a LOCAL branch.
 * - No local branch, working tree, index, tag or submodule is touched; no
 *   pruning, whatever `fetch.prune` says; no gc, no commit-graph; and NO
 *   FETCH_HEAD — a developer's own `git pull` reads it between its fetch and
 *   its merge, and a background fetch landing in that gap would make the pull
 *   merge the wrong thing. The developer's own `reference-transaction` hook
 *   runs, as it does for any fetch of theirs.
 *
 * GIT AND SSH CANNOT ASK. The worker has no controlling terminal
 * (fetch-trigger.ts starts it in its own session), and every route git or
 * ssh has to a prompt is closed: git's terminal prompt, every askpass program
 * (an editor's opens a dialog), ssh's askpass, and ssh itself runs in batch
 * mode — unless the developer chose their own ssh command, which is kept
 * exactly as it is. Credential helpers still run, because a stored token is
 * how a silent fetch authenticates; they are told `credential.interactive=
 * false` (and Git Credential Manager `GCM_INTERACTIVE=never`), but a helper or
 * an ssh agent that ignores both can still show a dialog of its own.
 *
 * BOUNDED, AND NOTHING LEFT BEHIND. Each network call leads its own process
 * group, and at its deadline that group is ended — SIGTERM so git removes its
 * ref locks, then SIGKILL — before the worker goes on (git/git.ts
 * `ownGroup`). Only the abandoned call's tree: a credential-cache daemon an
 * earlier, finished call started stays the developer's. Git runs with exactly
 * the environment the hook was given, not this process's plus it.
 *
 * The outcome is named, never git's own words: those can carry a URL with a
 * token in it, and they go into a file `doctor` prints.
 */
import { crosscheckHome } from "../config/paths.ts";
import type { Env } from "../config/paths.ts";
import {
  LANDING_FETCH_LOCAL_GIT_TIMEOUT_MS,
  LANDING_FETCH_TIMEOUT_MS,
  LANDING_LS_REMOTE_TIMEOUT_MS,
} from "../constants.ts";
import { runGitOutcome } from "../git/git.ts";
import type { CommandFailure } from "../git/git.ts";
import { readLandingFetchPlan } from "./fetch-switch.ts";
import type { LandingFetchPlan } from "./fetch-switch.ts";
import { cloneKeyOf, recordLandingFetch } from "./fetch-state.ts";
import type { LandingFetchOutcome, LandingFetchStep } from "./fetch-state.ts";
import {
  isBranchName,
  landingBranchCandidates,
  landingRefOf,
  resolveLandingRefs,
  selectLandingBranches,
} from "./landing-branches.ts";
import type { OriginRefs } from "./landing-branches.ts";

/**
 * Every route to a prompt, closed. `GIT_ASKPASS=false` outranks `core.askPass`
 * and `SSH_ASKPASS` for git's own prompts; a program that fails is a refusal,
 * and with the terminal prompt off that ends in an error, never a question.
 *
 * On git 2.46 and later `credential.interactive=false` (NETWORK_CONFIG) stops
 * git's own prompts by itself — measured: an askpass named in GIT_ASKPASS ran
 * twice without it and never with it — so these two are what closes the same
 * door on git 2.29–2.45, and no test on a newer git can see them work.
 */
export const NO_PROMPT_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "false",
  SSH_ASKPASS_REQUIRE: "never",
  GCM_INTERACTIVE: "never",
};

/** Only when the developer has no ssh command of their own (see `hasOwnSsh`). */
const BATCH_SSH_COMMAND = "ssh -o BatchMode=yes";

const FETCH_FLAGS: readonly string[] = [
  "--quiet",
  "--no-tags",
  "--no-prune",
  "--no-recurse-submodules",
  "--no-write-fetch-head",
  "--no-auto-maintenance",
  "--refmap=",
];

/**
 * `-c` for every network call: helpers that honour it never prompt, and no
 * commit-graph file is written into the developer's `.git` on our account.
 * A git older than 2.46 ignores the key it does not know.
 */
const NETWORK_CONFIG: readonly string[] = [
  "-c",
  "credential.interactive=false",
  "-c",
  "fetch.writeCommitGraph=false",
];

/** `--no-write-fetch-head` and `--no-auto-maintenance` arrived in git 2.29. */
const MIN_GIT: readonly [number, number] = [2, 29];

const HEADS = "refs/heads/";
const SYMREF_PREFIX = "ref: ";

type GitOutcome = { readonly ok: true; readonly stdout: string } | CommandFailure;

const definedEnv = (env: Env): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).flatMap(([name, value]) => (value === undefined ? [] : [[name, value]])),
  );

const isSet = (value: string | undefined): boolean => value !== undefined && value.length > 0;

/**
 * A developer who chose an ssh command meant it — a key per client, a jump
 * host, a wrapper. Setting GIT_SSH_COMMAND would override all three
 * (it outranks `core.sshCommand` and `GIT_SSH`), so theirs is kept, and it
 * still cannot prompt: the worker has no terminal.
 */
const hasOwnSsh = (env: Env, coreSshCommand: GitOutcome): boolean =>
  isSet(env["GIT_SSH_COMMAND"]) ||
  isSet(env["GIT_SSH"]) ||
  (coreSshCommand.ok && coreSshCommand.stdout.length > 0);

/**
 * `git ls-remote --symref origin HEAD refs/heads/<name>…` as OriginRefs.
 * origin's HEAD counts only when it RESOLVES (an empty repository names a
 * default branch that does not exist yet, and fetching it would fail).
 */
export const parseLsRemote = (stdout: string): OriginRefs => {
  const existing = new Map<string, string>();
  let symref: string | null = null;
  let headTip: string | null = null;
  for (const line of stdout.split("\n")) {
    const [left, name] = line.split("\t");
    if (left === undefined || name === undefined) {
      continue;
    }
    if (left.startsWith(SYMREF_PREFIX)) {
      symref = name === "HEAD" ? left.slice(SYMREF_PREFIX.length) : symref;
    } else if (name === "HEAD") {
      headTip = left;
    } else if (name.startsWith(HEADS)) {
      existing.set(name.slice(HEADS.length), left);
    }
  }
  const named = symref?.startsWith(HEADS) === true ? symref.slice(HEADS.length) : null;
  const headBranch = headTip !== null && named !== null && isBranchName(named) ? named : null;
  // The default branch's own line is only there when it is one of the names
  // asked about; the HEAD line carries its tip either way.
  if (headBranch !== null && headTip !== null && !existing.has(headBranch)) {
    existing.set(headBranch, headTip);
  }
  return { existing, headBranch };
};

/** `git version 2.50.1 (Apple Git-155)` → whether it is at least MIN_GIT. */
export const isGitRecentEnough = (version: string): boolean => {
  const match = /^git version (\d+)\.(\d+)/.exec(version.trim());
  if (match === null) {
    // A build that words its version differently is given the benefit: the
    // fetch itself is the real test, and doctor names what it says.
    return true;
  }
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > MIN_GIT[0] || (major === MIN_GIT[0] && minor >= MIN_GIT[1]);
};

const skipped = (why: Extract<LandingFetchOutcome, { kind: "skipped" }>["why"]): LandingFetchOutcome => ({
  kind: "skipped",
  why,
});

const failed = (step: LandingFetchStep, outcome: CommandFailure): LandingFetchOutcome => ({
  kind: "failed",
  step,
  timedOut: outcome.timedOut,
});

const refspecOf = (branch: string): string => `+${HEADS}${branch}:${landingRefOf(branch)}`;

export interface LandingFetchInput {
  readonly root: string;
  /** The developer's environment, as the hook was given it. */
  readonly env: Env;
  /**
   * The two network deadlines. Production always uses the defaults; a test
   * passes short ones to drive a real timeout without waiting two minutes.
   */
  readonly timeouts?: { readonly lsRemoteMs?: number; readonly fetchMs?: number };
}

interface GitCalls {
  /** A question about this clone: bounded, no network. */
  readonly local: (args: readonly string[]) => Promise<GitOutcome>;
  /** A call that reaches origin: its own process group, ended at the deadline. */
  readonly network: (
    args: readonly string[],
    timeoutMs: number,
    extra: Readonly<Record<string, string>>,
  ) => Promise<GitOutcome>;
}

const LOCAL_MS = LANDING_FETCH_LOCAL_GIT_TIMEOUT_MS;

const gitCallsFor = (input: LandingFetchInput): GitCalls => {
  const base = { ...definedEnv(input.env), ...NO_PROMPT_GIT_ENV };
  return {
    local: (args) => runGitOutcome(args, input.root, LOCAL_MS, base, { inheritEnv: false }),
    network: (args, timeoutMs, extra) =>
      runGitOutcome([...NETWORK_CONFIG, ...args], input.root, timeoutMs, { ...base, ...extra }, {
        inheritEnv: false,
        ownGroup: true,
      }),
  };
};

/**
 * Every branch the stop reads NOW (its rule on the clone's own refs), then
 * what the same rule picks on origin — each only while origin has it. The
 * union is what keeps the two from disagreeing when origin's default branch
 * moved after this clone was made: the clone's origin/HEAD still names the
 * old one (git does not update it either), the stop still reads it, so it is
 * the one that must stay fresh. `stopReads` is asked about in `ls-remote`
 * too, so a default branch with a name of its own (`trunk`) is not lost.
 */
const branchesToFetch = (
  setting: LandingFetchPlan["branches"],
  stopReads: readonly string[],
  origin: OriginRefs,
): readonly string[] => {
  const picked = [...selectLandingBranches(setting, origin), ...stopReads];
  return [...new Set(picked)].filter((branch) => origin.existing.has(branch));
};

const tipsOf = async (git: GitCalls, branches: readonly string[]): Promise<ReadonlyMap<string, string>> => {
  const listed = await git.local([
    "for-each-ref",
    "--format=%(refname)\t%(objectname)",
    ...branches.map(landingRefOf),
  ]);
  return new Map(
    listed.ok
      ? listed.stdout.split("\n").map((line): [string, string] => {
          const [ref = "", tip = ""] = line.split("\t");
          return [ref, tip];
        })
      : [],
  );
};

/**
 * One ref git refuses (a stale `origin/release` blocking `release/2026`)
 * fails git's whole answer, while the other refs DID move. What happened is
 * read off the refs, before against after: a ref that moved was brought; one
 * that did not move and is behind origin was missed; one that was already
 * current is neither. Nothing moved = the fetch failed, whatever was current
 * — a dropped connection must not read as a success.
 */
const afterRefusedFetch = async (
  git: GitCalls,
  branches: readonly string[],
  before: ReadonlyMap<string, string>,
  origin: OriginRefs,
  refusal: CommandFailure,
): Promise<LandingFetchOutcome> => {
  const after = await tipsOf(git, branches);
  const moved = (branch: string): boolean =>
    after.get(landingRefOf(branch)) !== before.get(landingRefOf(branch));
  const brought = branches.filter(moved);
  const missed = branches.filter(
    (branch) => !moved(branch) && after.get(landingRefOf(branch)) !== origin.existing.get(branch),
  );
  if (brought.length === 0) {
    return failed("fetch", refusal);
  }
  return missed.length === 0 ? { kind: "fetched", branches: brought } : { kind: "fetched", branches: brought, missed };
};

export const fetchLandingBranches = async (input: LandingFetchInput): Promise<LandingFetchOutcome> => {
  const plan = await readLandingFetchPlan(input.root, input.env);
  if (plan.switch.kind === "off") {
    return skipped("off");
  }
  const git = gitCallsFor(input);
  const [origin, shallow, coreSshCommand, version, stopRefs] = await Promise.all([
    git.local(["config", "--get", "remote.origin.url"]),
    git.local(["rev-parse", "--is-shallow-repository"]),
    git.local(["config", "--get", "core.sshCommand"]),
    git.local(["version"]),
    resolveLandingRefs(input.root, plan.branches, LOCAL_MS),
  ]);
  if (!origin.ok || origin.stdout.length === 0) {
    return skipped("no-origin");
  }
  // The stop is silent in a shallow clone (its boundary reads as touching
  // every file), so there is nothing a fetch could make it see.
  if (shallow.ok && shallow.stdout === "true") {
    return skipped("shallow");
  }
  if (version.ok && !isGitRecentEnough(version.stdout)) {
    return skipped("old-git");
  }
  const ssh = hasOwnSsh(input.env, coreSshCommand) ? {} : { GIT_SSH_COMMAND: BATCH_SSH_COMMAND };
  const stopReads = (stopRefs ?? []).map(({ branch }) => branch);
  const asked = [...new Set([...landingBranchCandidates(plan.branches), ...stopReads])];
  const listed = await git.network(
    ["ls-remote", "--symref", "origin", "HEAD", ...asked.map((name) => `${HEADS}${name}`)],
    input.timeouts?.lsRemoteMs ?? LANDING_LS_REMOTE_TIMEOUT_MS,
    ssh,
  );
  if (!listed.ok) {
    return failed("ls-remote", listed);
  }
  const onOrigin = parseLsRemote(listed.stdout);
  const branches = branchesToFetch(plan.branches, stopReads, onOrigin);
  if (branches.length === 0) {
    return skipped("none-on-origin");
  }
  const before = await tipsOf(git, branches);
  const fetched = await git.network(
    ["fetch", ...FETCH_FLAGS, "origin", ...branches.map(refspecOf)],
    input.timeouts?.fetchMs ?? LANDING_FETCH_TIMEOUT_MS,
    ssh,
  );
  if (fetched.ok) {
    return { kind: "fetched", branches };
  }
  return fetched.timedOut
    ? failed("fetch", fetched)
    : afterRefusedFetch(git, branches, before, onOrigin, fetched);
};

const EXIT_OK = 0;
const EXIT_USAGE = 2;

const rootFrom = (argv: readonly string[]): string | null => {
  const at = argv.indexOf("--root");
  const root = at === -1 ? undefined : argv[at + 1];
  return root === undefined || root.length === 0 ? null : root;
};

/**
 * The worker process: `--root <worktree>`. Records what it did under the
 * clone's key in Crosscheck's home — never inside the repo. The exit code is
 * its own; nothing downstream reads it.
 */
export const runLandingFetchWorker = async (argv: readonly string[], env: Env): Promise<number> => {
  const root = rootFrom(argv);
  if (root === null) {
    return EXIT_USAGE;
  }
  const outcome = await fetchLandingBranches({ root, env });
  const key = await cloneKeyOf(root, LOCAL_MS);
  if (key !== null) {
    await recordLandingFetch(crosscheckHome(env), key, outcome, new Date());
  }
  return EXIT_OK;
};
