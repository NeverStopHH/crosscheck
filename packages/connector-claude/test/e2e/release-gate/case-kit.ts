/**
 * The small-team cases' common ground (N2–N5): one connected repo per case —
 * its seed carries the committed `.crosscheck.json` `crosscheck init` writes,
 * which the capture trust rule needs to follow an edit into a worktree — and
 * a developer's clone plus a worktree on their branch.
 */
import { dirname, join } from "node:path";

import { renderRepoConfig } from "@crosscheck/connector-core/config/repo-config.ts";

import { addWorktree, cloneFor, daysAgo, makeSeed } from "./git.ts";
import type { Person } from "./git.ts";
import type { Actor, HostSession } from "./host.ts";
import { MAIN_THREAD } from "./host.ts";

export interface CaseRepo {
  readonly label: string;
  readonly repoId: string;
  readonly remoteUrl: string;
  readonly seed: string;
}

export const fileSource = (path: string, note = "seed"): string => `// ${path} (${note})\nexport const value = ${String(path.length)};\n`;

/** A forge for `label` holding `paths` (and any literal `extra` files), dated well outside every recency window. */
export const seedCase = async (
  label: string,
  hubUrl: string,
  paths: readonly string[],
  extra: Readonly<Record<string, string>> = {},
): Promise<CaseRepo> => {
  const files = {
    ...Object.fromEntries(paths.map((path) => [path, fileSource(path)])),
    ...extra,
    "README.md": `# ${label}\n`,
    ".crosscheck.json": renderRepoConfig(hubUrl),
  };
  const { root } = await makeSeed(label, files, daysAgo(60));
  return { label, repoId: `github.com/acme/${label}`, remoteUrl: `git@github.com:acme/${label}.git`, seed: root };
};

export interface Checkout {
  readonly clone: string;
  readonly worktree: string;
  /** The directory holding both — what a case deletes. */
  readonly parent: string;
}

/** `person`'s clone of the case repo and a worktree on `branch` cut from origin/main. */
export const checkoutFor = async (repo: CaseRepo, person: Person, branch: string, tag: string): Promise<Checkout> => {
  const clone = await cloneFor(repo.seed, `${repo.label}-${tag}`, repo.remoteUrl, person);
  const worktree = await addWorktree(clone, join(dirname(clone), tag), branch, "origin/main");
  return { clone, worktree, parent: dirname(clone) };
};

/** One Edit/Write per path, in order, as `actor`. */
export const editEach = async (
  session: HostSession,
  root: string,
  paths: readonly string[],
  note: string,
  actor: Actor = MAIN_THREAD,
): Promise<void> => {
  for (const path of paths) {
    await session.edit(join(root, path), fileSource(path, note), actor);
  }
};
