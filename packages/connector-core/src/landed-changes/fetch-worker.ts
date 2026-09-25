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
 * WHAT IT TOUCHES: `refs/remotes/origin/<landing branch>`, NOTHING ELSE.
 * - Origin is asked first which landing branches it has (`ls-remote`, one
 *   round trip): an explicit refspec for a branch origin lacks fails the
 *   whole fetch, and one mistyped name in `.crosscheck.json` would then cost
 *   every branch.
 * - The branches are chosen by the stop's own rule (landing-branches.ts
 *   `selectLandingBranches`), applied to origin's branches instead of the
 *   clone's, so the fetch and the stop cannot disagree about which matter.
 * - No local branch, working tree, index, tag or submodule is touched; no
 *   pruning, whatever `fetch.prune` says; no gc; and NO FETCH_HEAD — a
 *   developer's own `git pull` reads it between its fetch and its merge, and a
 *   background fetch landing in that gap would make the pull merge the wrong
 *   thing.
 *
 * IT CAN NEVER ASK ANYTHING. The worker has no controlling terminal
 * (fetch-trigger.ts starts it in its own session), and on top of that every
 * route git or ssh has to a prompt is closed: git's terminal prompt, every
 * askpass program (an editor's opens a dialog), ssh's askpass, Git Credential
 * Manager's UI, and ssh itself runs in batch mode — unless the developer
 * chose their own ssh command, which is kept exactly as it is. Only
 * credentials that work silently are used.
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
import { cloneKeyOf, recordLandingFetch } from "./fetch-state.ts";
import type { LandingFetchOutcome, LandingFetchStep } from "./fetch-state.ts";
import {
  isBranchName,
  landingBranchCandidates,
  landingRefOf,
  selectLandingBranches,
} from "./landing-branches.ts";
import type { OriginRefs } from "./landing-branches.ts";

/**
 * Every route to a prompt, closed. `GIT_ASKPASS=false` outranks `core.askPass`
 * and `SSH_ASKPASS` for git's own prompts; a program that fails is a refusal,
 * and with the terminal prompt off that ends in an error, never a question.
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
];

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
  let headResolves = false;
  for (const line of stdout.split("\n")) {
    const [left, name] = line.split("\t");
    if (left === undefined || name === undefined) {
      continue;
    }
    if (left.startsWith(SYMREF_PREFIX)) {
      symref = name === "HEAD" ? left.slice(SYMREF_PREFIX.length) : symref;
    } else if (name === "HEAD") {
      headResolves = true;
    } else if (name.startsWith(HEADS)) {
      existing.set(name.slice(HEADS.length), left);
    }
  }
  const headBranch = symref?.startsWith(HEADS) === true ? symref.slice(HEADS.length) : null;
  return {
    existing,
    headBranch: headResolves && headBranch !== null && isBranchName(headBranch) ? headBranch : null,
  };
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
}

export const fetchLandingBranches = async (input: LandingFetchInput): Promise<LandingFetchOutcome> => {
  const plan = await readLandingFetchPlan(input.root, input.env);
  if (plan.switch.kind === "off") {
    return skipped("off");
  }
  const base = { ...definedEnv(input.env), ...NO_PROMPT_GIT_ENV };
  const git = (
    args: readonly string[],
    timeoutMs: number,
    extra: Readonly<Record<string, string>> = {},
  ): Promise<GitOutcome> => runGitOutcome(args, input.root, timeoutMs, { ...base, ...extra });
  const [origin, shallow, coreSshCommand] = await Promise.all([
    git(["config", "--get", "remote.origin.url"], LANDING_FETCH_LOCAL_GIT_TIMEOUT_MS),
    git(["rev-parse", "--is-shallow-repository"], LANDING_FETCH_LOCAL_GIT_TIMEOUT_MS),
    git(["config", "--get", "core.sshCommand"], LANDING_FETCH_LOCAL_GIT_TIMEOUT_MS),
  ]);
  if (!origin.ok || origin.stdout.length === 0) {
    return skipped("no-origin");
  }
  // The stop is silent in a shallow clone (its boundary reads as touching
  // every file), so there is nothing a fetch could make it see.
  if (shallow.ok && shallow.stdout === "true") {
    return skipped("shallow");
  }
  const ssh = hasOwnSsh(input.env, coreSshCommand) ? {} : { GIT_SSH_COMMAND: BATCH_SSH_COMMAND };
  const listed = await git(
    [
      "ls-remote",
      "--symref",
      "origin",
      "HEAD",
      ...landingBranchCandidates(plan.branches).map((name) => `${HEADS}${name}`),
    ],
    LANDING_LS_REMOTE_TIMEOUT_MS,
    ssh,
  );
  if (!listed.ok) {
    return failed("ls-remote", listed);
  }
  const branches = selectLandingBranches(plan.branches, parseLsRemote(listed.stdout));
  if (branches.length === 0) {
    return skipped("none-on-origin");
  }
  const fetched = await git(
    ["fetch", ...FETCH_FLAGS, "origin", ...branches.map(refspecOf)],
    LANDING_FETCH_TIMEOUT_MS,
    ssh,
  );
  return fetched.ok ? { kind: "fetched", branches } : failed("fetch", fetched);
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
  const key = await cloneKeyOf(root, LANDING_FETCH_LOCAL_GIT_TIMEOUT_MS);
  if (key !== null) {
    await recordLandingFetch(crosscheckHome(env), key, outcome, new Date());
  }
  return EXIT_OK;
};
