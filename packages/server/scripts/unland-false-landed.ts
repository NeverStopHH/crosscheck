/**
 * UN-LAND THE CONTEXTS A BASE-ANCESTRY STAMP GOT WRONG — opt-in, dry run
 * first (pilot finding, 2026-10-05; services/landed-repair.ts says which).
 *
 *   bun packages/server/scripts/unland-false-landed.ts --data-dir <dir> \
 *     [--scope open|all] [--default-branch <ref>] [--git-dir <clone>] \
 *     [--stale-base <sha>]... [--apply]
 *
 * `--scope open` judges only contexts whose session is still open — the
 * stamps hiding live work from collision checks today, and the run the pilot
 * owner chose for the real hub. `--scope all` judges every landed context,
 * which also rewrites the past windows of the pilot report's "both landed"
 * figure. A dry run defaults to `all`; `--apply` refuses to guess and needs
 * the scope named. Every run says to save the pilot report first.
 *
 * STOP THE HUB FIRST, AND RUN IT ON A COPY FIRST. A PGlite data dir is one
 * process's (docs/OPERATIONS.md), and opening it runs this version's
 * bootstrap like a hub start would. Nothing here has a default data dir: the
 * one it reads is the one it is told.
 *
 * DRY RUN UNLESS --apply, AND COUNTS ONLY. It prints how many contexts are
 * landed and how many of those it would un-land, by reason — never an id, a
 * title, a branch or a sha, so its output can be pasted anywhere. `--git-dir`
 * names a clone of the repo to date base commits in (git's committer date);
 * without one, a base's age is not judged and the output says so.
 * `--default-branch` names the repo's default branch (`main` or `origin/main`)
 * so sessions ON it are judged, as the ingest judges them; without it they
 * are not, and the output says so. `--stale-base` names a commit known to be
 * a stale checkout; repeatable.
 */
import { COMMIT_SHA_PATTERN } from "@crosscheck/schema";

import { closeDb, createDb } from "../src/db/client.ts";
import type { Db } from "../src/db/client.ts";
import {
  REPAIR_SCOPES,
  listLandedContexts,
  planLandedRepair,
  unlandContexts,
} from "../src/services/landed-repair.ts";
import type { RepairPlan, RepairScope } from "../src/services/landed-repair.ts";

const USAGE =
  "usage: unland-false-landed.ts --data-dir <dir> [--scope open|all] [--default-branch <ref>] [--git-dir <clone>] [--stale-base <sha>]... [--apply]";
/** What a dry run judges when no scope is named. */
const DRY_RUN_SCOPE: RepairScope = "all";
const SCOPE_LINES: Readonly<Record<RepairScope, string>> = {
  open: "scope: contexts on open sessions",
  all: "scope: every landed context",
};
const PILOT_SNAPSHOT_REMINDER =
  "before --apply: save the pilot report (crosscheck pilot --json > pilot-before.json) — " +
  "un-landing changes its \"both landed\" figure, and --scope all rewrites past windows";
const EXIT_OK = 0;
const EXIT_USAGE = 2;
/** One `git log` per this many bases — an argv bound, not a cost bound. */
const GIT_SHAS_PER_CALL = 200;
/** A local `git log --no-walk` over a few hundred commits; generous on purpose. */
const GIT_TIMEOUT_MS = 30_000;
const FIELD_SEPARATOR = "\t";

export interface OpenedHub {
  readonly db: Db;
  readonly close: () => Promise<void>;
}

export interface UnlandDeps {
  readonly openDb: (dataDir: string) => Promise<OpenedHub>;
  readonly readCommitDates: (gitDir: string, shas: readonly string[]) => Promise<ReadonlyMap<string, Date>>;
  /** Is this path a git repository? Checked before the hub is opened. */
  readonly isGitDir: (gitDir: string) => Promise<boolean>;
  readonly write: (line: string) => void;
}

interface Options {
  readonly dataDir: string;
  readonly scope: RepairScope;
  readonly defaultBranch: string | null;
  readonly gitDir: string | null;
  readonly staleBases: readonly string[];
  readonly apply: boolean;
}

type Parsed = { readonly ok: true; readonly options: Options } | { readonly ok: false; readonly error: string };

const VALUE_FLAGS = new Set(["--data-dir", "--scope", "--default-branch", "--git-dir", "--stale-base"]);

const isRepairScope = (value: string): value is RepairScope =>
  (REPAIR_SCOPES as readonly string[]).includes(value);

/** argv as flag/value pairs; a flag that takes a value consumes the next word. */
const tokenize = (argv: readonly string[]): readonly (readonly [string, string | null])[] => {
  const pairs: (readonly [string, string | null])[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? "";
    if (VALUE_FLAGS.has(flag)) {
      pairs.push([flag, argv[index + 1] ?? null]);
      index += 1;
    } else {
      pairs.push([flag, null]);
    }
  }
  return pairs;
};

const parseArgs = (argv: readonly string[]): Parsed => {
  const pairs = tokenize(argv);
  const unknown = pairs.find(([flag]) => !VALUE_FLAGS.has(flag) && flag !== "--apply");
  if (unknown !== undefined) {
    return { ok: false, error: `unknown argument ${unknown[0]}` };
  }
  if (pairs.some(([flag, value]) => VALUE_FLAGS.has(flag) && (value === null || value.length === 0))) {
    return { ok: false, error: "a flag is missing its value" };
  }
  const valuesOf = (flag: string): readonly string[] =>
    pairs.flatMap(([name, value]) => (name === flag && value !== null ? [value] : []));
  const dataDir = valuesOf("--data-dir").at(-1);
  if (dataDir === undefined) {
    return { ok: false, error: "--data-dir is required: name the (stopped, copied) hub data dir" };
  }
  const staleBases = valuesOf("--stale-base");
  const notASha = staleBases.find((sha) => !COMMIT_SHA_PATTERN.test(sha));
  if (notASha !== undefined) {
    return { ok: false, error: "--stale-base takes a commit sha" };
  }
  const scope = valuesOf("--scope").at(-1);
  if (scope !== undefined && !isRepairScope(scope)) {
    return { ok: false, error: "--scope is open or all" };
  }
  const apply = pairs.some(([flag]) => flag === "--apply");
  if (apply && scope === undefined) {
    return { ok: false, error: "--apply needs --scope open or --scope all: name what it may change" };
  }
  return {
    ok: true,
    options: {
      dataDir,
      scope: scope ?? DRY_RUN_SCOPE,
      defaultBranch: valuesOf("--default-branch").at(-1) ?? null,
      gitDir: valuesOf("--git-dir").at(-1) ?? null,
      staleBases: staleBases.map((sha) => sha.toLowerCase()),
      apply,
    },
  };
};

const reasonLine = (plan: RepairPlan, options: Options, judgedAge: boolean): string =>
  [
    `connector said so ${String(plan.byReason.flagged)}`,
    `detached ${String(plan.byReason.detached)}`,
    options.defaultBranch === null
      ? "on the default branch not judged (no --default-branch)"
      : `on the default branch ${String(plan.byReason.default)}`,
    `operator-named base ${String(plan.byReason.named)}`,
    judgedAge ? `stale base ${String(plan.byReason.stale)}` : "stale base not judged (no --git-dir)",
  ].join(" · ");

/**
 * How many of the judged bases the clone could date — so a clone that is the
 * wrong repo, or too shallow, shows as "0 of 412 dated" instead of passing for
 * a hub with no stale bases.
 */
const datedLine = (bases: readonly string[], dates: ReadonlyMap<string, Date>): string => {
  const dated = bases.filter((sha) => dates.has(sha)).length;
  return `git dates: ${String(dated)} of ${String(bases.length)} bases dated, ${String(bases.length - dated)} not in that clone`;
};

const runOnHub = async (db: Db, options: Options, deps: UnlandDeps): Promise<void> => {
  deps.write(SCOPE_LINES[options.scope]);
  const rows = await listLandedContexts(db, options.scope);
  const bases = [...new Set(rows.map((row) => row.baseCommit))];
  const baseCommittedAt = options.gitDir === null ? null : await deps.readCommitDates(options.gitDir, bases);
  if (baseCommittedAt !== null) {
    deps.write(datedLine(bases, baseCommittedAt));
  }
  const plan = planLandedRepair(rows, {
    defaultBranch: options.defaultBranch,
    namedBases: new Set(options.staleBases),
    baseCommittedAt,
  });
  deps.write(`landed contexts: ${String(plan.landed)}`);
  deps.write(
    `stamped by base ancestry with the base already on the default branch: ${String(plan.unland.length)} ` +
      `(${reasonLine(plan, options, baseCommittedAt !== null)})`,
  );
  deps.write(PILOT_SNAPSHOT_REMINDER);
  if (!options.apply) {
    deps.write("dry run: nothing changed — run again with --apply to un-land them");
    return;
  }
  deps.write(`un-landed ${String(await unlandContexts(db, plan.unland))} contexts`);
};

/** The whole command, with its edges injected; the exit code it ends with. */
export const runUnlandFalseLanded = async (argv: readonly string[], deps: UnlandDeps): Promise<number> => {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    deps.write(`${parsed.error}\n${USAGE}`);
    return EXIT_USAGE;
  }
  // A wrong --git-dir would date nothing and read as "no stale bases"; it is
  // refused here, before the hub is opened, with the path it was given.
  if (parsed.options.gitDir !== null && !(await deps.isGitDir(parsed.options.gitDir))) {
    deps.write(`--git-dir is not a git repository: ${parsed.options.gitDir}\n${USAGE}`);
    return EXIT_USAGE;
  }
  const hub = await deps.openDb(parsed.options.dataDir);
  try {
    await runOnHub(hub.db, parsed.options, deps);
  } finally {
    await hub.close();
  }
  return EXIT_OK;
};

/** `git rev-parse --git-dir` succeeds there — a work tree, a bare clone, a worktree. */
export const isGitRepository = async (gitDir: string): Promise<boolean> => {
  const proc = Bun.spawn({
    cmd: ["git", "-C", gitDir, "rev-parse", "--git-dir"],
    stdout: "ignore",
    stderr: "ignore",
    timeout: GIT_TIMEOUT_MS,
  });
  return (await proc.exited) === 0;
};

const gitLog = async (gitDir: string, shas: readonly string[]): Promise<string> => {
  const proc = Bun.spawn({
    // --no-walk: these commits only, never their history; --ignore-missing:
    // a base this clone does not have reads nothing instead of failing all.
    cmd: ["git", "-C", gitDir, "log", "--no-walk=unsorted", "--ignore-missing", "--format=%H%x09%cI", ...shas],
    stdout: "pipe",
    stderr: "ignore",
    timeout: GIT_TIMEOUT_MS,
  });
  const output = await new Response(proc.stdout).text();
  return (await proc.exited) === 0 ? output : "";
};

/**
 * Each base's committer date, read from a clone. Only sha-shaped values reach
 * git; a base the clone does not have, or a git that fails, reads nothing —
 * and nothing is never a reason to un-land.
 */
export const readCommitDates = async (
  gitDir: string,
  shas: readonly string[],
): Promise<ReadonlyMap<string, Date>> => {
  const wanted = [...new Set(shas.filter((sha) => COMMIT_SHA_PATTERN.test(sha)))];
  const chunks = Array.from({ length: Math.ceil(wanted.length / GIT_SHAS_PER_CALL) }, (_, index) =>
    wanted.slice(index * GIT_SHAS_PER_CALL, (index + 1) * GIT_SHAS_PER_CALL),
  );
  const lines = (await Promise.all(chunks.map((chunk) => gitLog(gitDir, chunk))))
    .flatMap((output) => output.split("\n"))
    .map((line) => line.split(FIELD_SEPARATOR))
    .flatMap(([full, committed]) =>
      full === undefined || committed === undefined || Number.isNaN(Date.parse(committed))
        ? []
        : [{ full: full.toLowerCase(), at: new Date(committed) }],
    );
  return new Map(
    wanted.flatMap((sha) => {
      const found = lines.find((line) => line.full.startsWith(sha.toLowerCase()));
      return found === undefined ? [] : [[sha, found.at] as const];
    }),
  );
};

if (import.meta.main) {
  const code = await runUnlandFalseLanded(process.argv.slice(2), {
    openDb: async (dataDir) => {
      const db = await createDb({ dataDir });
      return { db, close: () => closeDb(db) };
    },
    readCommitDates,
    isGitDir: isGitRepository,
    write: (line) => {
      process.stdout.write(`${line}\n`);
    },
  });
  process.exit(code);
}
