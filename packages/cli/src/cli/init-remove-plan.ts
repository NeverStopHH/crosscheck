/**
 * The plan half of `crosscheck init --remove` (init-remove.ts runs it): what
 * each project file becomes — absent, untouched, stripped or deleted — decided
 * for EVERY file before ANY is written, the refusals that stop a run before it
 * changes anything, and the one sentence per file the output prints.
 */
import { lstat, realpath, rm } from "node:fs/promises";
import { basename, join, relative } from "node:path";

import { crosscheckHome, writePrivateFile } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import {
  readJsonConfig,
  refusalMessage,
  renderJsonFile,
  writeConfigAtomically,
} from "./init-io.ts";
import type { RemovalTarget, Stripped } from "./wiring-removal.ts";

/** Under CROSSCHECK_HOME: where a removal's originals are kept. */
const BACKUP_DIR = "backups";

export type FilePlan =
  | { readonly kind: "absent"; readonly path: string }
  | { readonly kind: "untouched"; readonly path: string; readonly stripped: Stripped }
  | {
      readonly kind: "delete";
      readonly path: string;
      readonly raw: string;
      readonly stripped: Stripped;
    }
  | {
      readonly kind: "strip";
      readonly path: string;
      readonly raw: string;
      readonly stripped: Stripped;
      /** Where the original was saved; null until `saveOriginals` ran. */
      readonly backup: string | null;
    };

type PlanResult =
  | { readonly ok: true; readonly plans: readonly FilePlan[] }
  | { readonly ok: false; readonly refusal: string };

const planFile = (
  target: RemovalTarget,
  value: Record<string, unknown>,
  raw: string | null,
): FilePlan => {
  if (raw === null) {
    return { kind: "absent", path: target.path };
  }
  const stripped = target.strip(value);
  if (!stripped.changed) {
    return { kind: "untouched", path: target.path, stripped };
  }
  return stripped.leftover
    ? { kind: "delete", path: target.path, raw, stripped }
    : { kind: "strip", path: target.path, raw, stripped, backup: null };
};

/** EVERY file is read and validated before ANY is written. */
export const planAll = async (targets: readonly RemovalTarget[]): Promise<PlanResult> => {
  const reads = await Promise.all(
    targets.map(async (target) => ({ target, read: await readJsonConfig(target.path) })),
  );
  const refused = reads.find(({ read }) => !read.ok);
  if (refused !== undefined && !refused.read.ok) {
    return { ok: false, refusal: refusalMessage(refused.target.path, refused.read.reason) };
  }
  const plans = reads.flatMap(({ target, read }) =>
    read.ok ? [planFile(target, read.value, read.raw)] : [],
  );
  const linked = await linkRefusal(plans);
  return linked === null ? { ok: true, plans } : { ok: false, refusal: linked };
};

/**
 * A file this run would CHANGE must not be a symlink (review 2026-10-05): the
 * rewrite is temp + rename, which turns the link into a regular file and
 * leaves the file it pointed at wired, and a delete removes only the link —
 * either way the output would claim a change to a file it never made. The
 * target is named, and nothing is changed; a link to a file without
 * crosscheck entries is never touched, so it is no reason to refuse.
 */
const linkRefusal = async (plans: readonly FilePlan[]): Promise<string | null> => {
  for (const plan of plans) {
    if (plan.kind !== "strip" && plan.kind !== "delete") {
      continue;
    }
    if ((await lstat(plan.path)).isSymbolicLink()) {
      const target = await realpath(plan.path);
      return `${plan.path} is a symlink to ${target} — init --remove does not edit a file through a link (everything else that links to it would change too), so nothing was changed; remove crosscheck's entries from ${target} itself`;
    }
  }
  return null;
};

/** One private directory per run, named for the repo it came from. */
export const removalBackupDir = (env: Env, root: string): string =>
  join(crosscheckHome(env), BACKUP_DIR, `init-remove-${String(Date.now())}-${basename(root)}`);

/**
 * Every file the run will REWRITE has its original saved first — OUT of the
 * work tree (review 2026-10-05). A `.mcp.json.bak-…` beside an ignored
 * `.mcp.json` is a new file `git status` offers to commit, holding whatever a
 * teammate's server keeps in its env, API keys included. Originals go to a
 * private directory (0700, files 0600) under CROSSCHECK_HOME, at their path
 * relative to the repo, and the output names each one. A DELETED file gets
 * none: it held nothing but crosscheck's entries, which `crosscheck init`
 * writes again.
 */
export const saveOriginals = async (
  plans: readonly FilePlan[],
  root: string,
  backupDir: string,
): Promise<readonly FilePlan[]> =>
  Promise.all(
    plans.map(async (plan) => {
      if (plan.kind !== "strip") {
        return plan;
      }
      const backup = join(backupDir, relative(root, plan.path));
      await writePrivateFile(backup, plan.raw);
      return { ...plan, backup };
    }),
  );

const applyPlan = async (plan: FilePlan): Promise<void> => {
  if (plan.kind === "strip") {
    await writeConfigAtomically(plan.path, renderJsonFile(plan.stripped.value));
  }
  if (plan.kind === "delete") {
    await rm(plan.path);
  }
};

export type ApplyOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** Changed before the failure — the repo is half-removed by exactly these. */
      readonly applied: readonly FilePlan[];
      readonly failed: FilePlan;
      /** Planned changes never attempted. */
      readonly pending: readonly FilePlan[];
      readonly error: string;
    };

const isChange = (plan: FilePlan): boolean => plan.kind === "strip" || plan.kind === "delete";

/**
 * Applies the plans in order and, when a write fails part-way (EACCES on the
 * second file, review 2026-10-05), says exactly which files were already
 * changed rather than letting the error escape as one bare line: the repo IS
 * half-removed at that point, and only this knows by which files.
 */
export const applyAll = async (plans: readonly FilePlan[]): Promise<ApplyOutcome> => {
  const changes = plans.filter(isChange);
  for (const [index, plan] of changes.entries()) {
    try {
      await applyPlan(plan);
    } catch (error) {
      return {
        ok: false,
        applied: changes.slice(0, index),
        failed: plan,
        pending: changes.slice(index + 1),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return { ok: true };
};

/**
 * Entries left in a file that look like crosscheck's but ran through a
 * launcher it does not recognise (wiring-lookalikes.ts): named, and NOT
 * removed — only a person can tell an `init --command-prefix` install from a
 * tool that happens to share a subcommand name.
 */
export const unrecognisedLine = (path: string, commands: readonly string[]): readonly string[] =>
  commands.length === 0
    ? []
    : [
        `${path}: left ${String(commands.length)} ${commands.length === 1 ? "entry" : "entries"} that look like crosscheck's but run through a launcher it does not recognise as its own — NOT removed: ${commands
          .map((command) => `\`${command}\``)
          .join(", ")}; if an \`init --command-prefix\` install wrote them, delete them by hand`,
      ];

/** The leftovers a plan's file still holds, as lines (none for absent or deleted files). */
export const planLeftovers = (plan: FilePlan): readonly string[] =>
  plan.kind === "untouched" || plan.kind === "strip"
    ? unrecognisedLine(plan.path, plan.stripped.unrecognised)
    : [];

export const planLine = (plan: FilePlan): string => {
  switch (plan.kind) {
    case "absent":
      return `${plan.path}: not present — nothing to remove`;
    case "untouched":
      return `${plan.path}: no crosscheck entries — left as is`;
    case "strip":
      return `${plan.path}: removed ${plan.stripped.removed}; everything else in it is kept${
        plan.backup === null ? "" : ` (original saved to ${plan.backup})`
      }`;
    case "delete":
      return `${plan.path}: removed ${plan.stripped.removed} and deleted the file — nothing else was in it`;
  }
};
