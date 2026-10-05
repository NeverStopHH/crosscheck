/**
 * `crosscheck init --remove` — the project-side uninstall (pilot, 2026-10).
 *
 * A teammate ran `crosscheck init` in his checkout and `crosscheck init
 * --global` as well. doctor's double-wiring WARN told him to keep the global
 * install and delete the gitignored project copy, and he asked "how?" — the
 * only `--remove` was `init --global --remove`, which deletes the side that
 * should stay. This removes THIS repo's crosscheck wiring and nothing else:
 *
 *   - crosscheck's hook entries and statusline in `.claude/settings.json`,
 *     and its server in `.mcp.json`; with `--cursor`, its entries in
 *     `.cursor/hooks.json` + `.cursor/mcp.json`;
 *   - identified by the SAME table `init --global --remove` walks
 *     (wiring-removal.ts), never by a second copy of the matching rule;
 *   - never `.crosscheck.json` (the team's repo connection), never a foreign
 *     entry, never a user-level file.
 *
 * Unlike the user-level removal, which skips a file it cannot parse, this
 * one REFUSES and writes nothing — the project install's rule: these files
 * belong to a repo, and a half-removed repo is the state doctor explains
 * worst. A file the strip leaves holding nothing but install-created
 * structure is deleted; any other changed file is rewritten through the
 * same backup + atomic write the installs use.
 */
import { rm } from "node:fs/promises";
import { join, relative } from "node:path";

import {
  CLAUDE_SETTINGS_DIR,
  CLAUDE_SETTINGS_FILE,
  EXIT_ABORTED,
  EXIT_FAIL,
  EXIT_OK,
  MCP_CONFIG_FILE,
} from "@crosscheck/connector-core/constants.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { repoConfigPath } from "@crosscheck/connector-core/config/repo-config.ts";
import { isPathTracked } from "@crosscheck/connector-core/git/check-ignore.ts";
import { resolveRepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import { readGlobalWiring } from "./doctor-global.ts";
import {
  readJsonConfig,
  refusalMessage,
  renderJsonFile,
  writeIfChanged,
} from "./init-io.ts";
import { REMOVE_RESTART_LINE, removalTargets } from "./wiring-removal.ts";
import type { RemovalTarget, Stripped } from "./wiring-removal.ts";
import type { CliResult } from "./login.ts";

export interface ProjectRemoveOptions {
  /** Include `.cursor/hooks.json` + `.cursor/mcp.json`, as `init --cursor` did. */
  readonly cursor: boolean;
}

type FilePlan =
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
const planAll = async (targets: readonly RemovalTarget[]): Promise<PlanResult> => {
  const reads = await Promise.all(
    targets.map(async (target) => ({ target, read: await readJsonConfig(target.path) })),
  );
  const refused = reads.find(({ read }) => !read.ok);
  if (refused !== undefined && !refused.read.ok) {
    return { ok: false, refusal: refusalMessage(refused.target.path, refused.read.reason) };
  }
  return {
    ok: true,
    plans: reads.flatMap(({ target, read }) =>
      read.ok ? [planFile(target, read.value, read.raw)] : [],
    ),
  };
};

const applyPlan = async (plan: FilePlan): Promise<void> => {
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

const planLine = (plan: FilePlan): string => {
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

/**
 * A changed file git TRACKS is a change every teammate receives once it is
 * committed — the opposite of the ignored project copy this command was built
 * for. Said per file, with both ways out, because only the developer knows
 * whether the team's install should go.
 */
const teamChangeNote = async (root: string, plan: FilePlan): Promise<readonly string[]> => {
  if (plan.kind !== "strip" && plan.kind !== "delete") {
    return [];
  }
  const path = relative(root, plan.path);
  if ((await isPathTracked(root, path)) !== true) {
    return [];
  }
  return [
    `note: ${path} is tracked by git, so this changes a file your teammates share — commit it only if the whole team should stop loading crosscheck from this repo; otherwise put it back with \`git restore -- ${path}\``,
  ];
};

const projectCursorDir = async (root: string): Promise<string> => {
  // DYNAMIC like every Cursor branch of init: hooks and the statusline must
  // not pay connector-cursor's load.
  const { CURSOR_DIR } = await import("@crosscheck/connector-cursor");
  return join(root, CURSOR_DIR);
};

const cursorLeftLine = async (root: string): Promise<readonly string[]> => {
  const { CURSOR_HOOKS_FILE, CURSOR_MCP_FILE } = await import("@crosscheck/connector-cursor");
  const dir = await projectCursorDir(root);
  const present = await Promise.all(
    [CURSOR_HOOKS_FILE, CURSOR_MCP_FILE].map((name) => Bun.file(join(dir, name)).exists()),
  );
  return present.some(Boolean)
    ? [`left ${dir} in place — crosscheck's cursor entries there go only with --cursor`]
    : [];
};

const userLevelLine = async (env: Env): Promise<string> => {
  const wiring = await readGlobalWiring(env);
  if (wiring.unreadable) {
    return `left ${wiring.settingsPath} untouched — it is not valid json, so whether a user-level install still wires this repo cannot be read`;
  }
  if (wiring.hooksInstalled) {
    return `left the user-level install in place (${wiring.settingsPath}) — it keeps wiring this repo and every other checkout on this machine`;
  }
  return "no user-level install either: sessions starting in this repo now load no crosscheck hooks — `crosscheck init --global` wires every checkout on this machine";
};

/** What this command never touches, said so nobody has to wonder. */
const leftInPlaceLines = async (
  root: string,
  env: Env,
  cursor: boolean,
): Promise<readonly string[]> => {
  const connection = repoConfigPath(root);
  return [
    ...((await Bun.file(connection).exists())
      ? [`left ${connection} in place — the team's repo connection; init --remove never touches it`]
      : []),
    ...(cursor ? [] : await cursorLeftLine(root)),
    await userLevelLine(env),
  ];
};

export const runProjectRemove = async (
  options: ProjectRemoveOptions,
  env: Env,
  cwd: string,
): Promise<CliResult> => {
  const identity = await resolveRepoIdentity(cwd);
  if (identity === null) {
    return { stdout: "not a git repository\n", exitCode: EXIT_FAIL };
  }
  const root = identity.root;
  const targets = await removalTargets({
    claudeSettingsPath: join(root, CLAUDE_SETTINGS_DIR, CLAUDE_SETTINGS_FILE),
    mcpPath: join(root, MCP_CONFIG_FILE),
    cursorDir: options.cursor ? await projectCursorDir(root) : null,
  });
  const planned = await planAll(targets);
  if (!planned.ok) {
    return { stdout: `${planned.refusal}\n`, exitCode: EXIT_ABORTED };
  }
  for (const plan of planned.plans) {
    await applyPlan(plan);
  }
  const notes = await Promise.all(planned.plans.map((plan) => teamChangeNote(root, plan)));
  return {
    stdout: [
      ...planned.plans.map(planLine),
      ...notes.flat(),
      ...(await leftInPlaceLines(root, env, options.cursor)),
      REMOVE_RESTART_LINE,
      "",
    ].join("\n"),
    exitCode: EXIT_OK,
  };
};
