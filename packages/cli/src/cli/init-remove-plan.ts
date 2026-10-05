/**
 * The plan half of `crosscheck init --remove` (init-remove.ts runs it): what
 * each project file becomes — absent, untouched, stripped or deleted — decided
 * for EVERY file before ANY is written, the refusals that stop a run before it
 * changes anything, and the one sentence per file the output prints.
 */
import { lstat, realpath, rm } from "node:fs/promises";

import {
  readJsonConfig,
  refusalMessage,
  renderJsonFile,
  writeIfChanged,
} from "./init-io.ts";
import type { RemovalTarget, Stripped } from "./wiring-removal.ts";

export type FilePlan =
  | { readonly kind: "absent" | "untouched"; readonly path: string }
  | {
      readonly kind: "strip" | "delete";
      readonly path: string;
      readonly raw: string;
      readonly stripped: Stripped;
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
    return { kind: "untouched", path: target.path };
  }
  return { kind: stripped.leftover ? "delete" : "strip", path: target.path, raw, stripped };
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

export const applyPlan = async (plan: FilePlan): Promise<void> => {
  if (plan.kind === "strip") {
    await writeIfChanged(plan.path, plan.raw, renderJsonFile(plan.stripped.value));
  }
  if (plan.kind === "delete") {
    // No backup, unlike every rewrite: the file held nothing of the user's,
    // `crosscheck init` writes the same content again, and a fresh
    // `.mcp.json.bak-…` would be the one new file an ignored-copy cleanup
    // leaves in `git status`.
    await rm(plan.path);
  }
};

export const planLine = (plan: FilePlan): string => {
  switch (plan.kind) {
    case "absent":
      return `${plan.path}: not present — nothing to remove`;
    case "untouched":
      return `${plan.path}: no crosscheck entries — left as is`;
    case "strip":
      return `${plan.path}: removed ${plan.stripped.removed}; everything else in it is kept`;
    case "delete":
      return `${plan.path}: removed ${plan.stripped.removed} and deleted the file — nothing else was in it`;
  }
};
