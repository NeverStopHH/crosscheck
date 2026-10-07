/**
 * UN-LAND THE CONTEXTS A BASE-ANCESTRY STAMP GOT WRONG — opt-in, dry run
 * first (pilot finding, 2026-10-05; services/landed-repair.ts says which).
 *
 *   bun packages/server/scripts/unland-false-landed.ts --data-dir <dir> \
 *     [--git-dir <clone>] [--stale-base <sha>]... [--apply]
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
 * `--stale-base` names a commit known to be a stale checkout; repeatable.
 */
import { COMMIT_SHA_PATTERN } from "@crosscheck/schema";

import { closeDb, createDb } from "../src/db/client.ts";
import type { Db } from "../src/db/client.ts";
import {
  listLandedContexts,
  planLandedRepair,
  unlandContexts,
} from "../src/services/landed-repair.ts";
import type { RepairPlan } from "../src/services/landed-repair.ts";

const USAGE =
  "usage: unland-false-landed.ts --data-dir <dir> [--git-dir <clone>] [--stale-base <sha>]... [--apply]";
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
  readonly write: (line: string) => void;
}

interface Options {
  readonly dataDir: string;
  readonly gitDir: string | null;
  readonly staleBases: readonly string[];
  readonly apply: boolean;
}

type Parsed = { readonly ok: true; readonly options: Options } | { readonly ok: false; readonly error: string };

const VALUE_FLAGS = new Set(["--data-dir", "--git-dir", "--stale-base"]);

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
  return {
    ok: true,
    options: {
      dataDir,
      gitDir: valuesOf("--git-dir").at(-1) ?? null,
      staleBases: staleBases.map((sha) => sha.toLowerCase()),
      apply: pairs.some(([flag]) => flag === "--apply"),
    },
  };
};

const reasonLine = (plan: RepairPlan, judgedAge: boolean): string =>
  [
    `connector said so ${String(plan.byReason.flagged)}`,
    `detached ${String(plan.byReason.detached)}`,
    `operator-named base ${String(plan.byReason.named)}`,
    judgedAge ? `stale base ${String(plan.byReason.stale)}` : "stale base not judged (no --git-dir)",
  ].join(" · ");

const runOnHub = async (db: Db, options: Options, deps: UnlandDeps): Promise<void> => {
  const rows = await listLandedContexts(db);
  const baseCommittedAt =
    options.gitDir === null
      ? null
      : await deps.readCommitDates(options.gitDir, [...new Set(rows.map((row) => row.baseCommit))]);
  const plan = planLandedRepair(rows, { namedBases: new Set(options.staleBases), baseCommittedAt });
  deps.write(`landed contexts: ${String(plan.landed)}`);
  deps.write(
    `stamped by base ancestry with the base already on the default branch: ${String(plan.unland.length)} ` +
      `(${reasonLine(plan, baseCommittedAt !== null)})`,
  );
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
  const hub = await deps.openDb(parsed.options.dataDir);
  try {
    await runOnHub(hub.db, parsed.options, deps);
  } finally {
    await hub.close();
  }
  return EXIT_OK;
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
    write: (line) => {
      process.stdout.write(`${line}\n`);
    },
  });
  process.exit(code);
}
