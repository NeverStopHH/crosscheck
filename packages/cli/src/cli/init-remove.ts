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
 * structure is deleted; any other changed file is rewritten atomically, its
 * original saved OUTSIDE the work tree and named (init-remove-plan.ts).
 */
import { join, relative } from "node:path";

import {
  EXIT_ABORTED,
  EXIT_FAIL,
  EXIT_OK,
} from "@crosscheck/connector-core/constants.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { repoConfigPath } from "@crosscheck/connector-core/config/repo-config.ts";
import { isPathTracked } from "@crosscheck/connector-core/git/check-ignore.ts";
import { resolveRepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import { readGlobalWiring } from "./doctor-global.ts";
import {
  applyAll,
  planAll,
  planLine,
  removalBackupDir,
  saveOriginals,
} from "./init-remove-plan.ts";
import type { ApplyOutcome, FilePlan } from "./init-remove-plan.ts";
import { REMOVE_RESTART_LINE, removalTargets } from "./wiring-removal.ts";
import {
  collisionSentence,
  findUserLevelCollision,
  projectWiringFiles,
} from "./wiring-scope.ts";
import type { CliResult } from "./login.ts";

export interface ProjectRemoveOptions {
  /** Include `.cursor/hooks.json` + `.cursor/mcp.json`, as `init --cursor` did. */
  readonly cursor: boolean;
}

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

/** A run that stopped part-way: what changed, where it stopped, what did not. */
const failureReport = (outcome: ApplyOutcome & { readonly ok: false }): string =>
  [
    `stopped at ${outcome.failed.path}: ${outcome.error}`,
    ...(outcome.applied.length === 0
      ? ["nothing had been changed before that — the repo is as it was"]
      : ["already changed before that:", ...outcome.applied.map((plan) => `  ${planLine(plan)}`)]),
    `not changed: ${[outcome.failed, ...outcome.pending].map((plan) => plan.path).join(", ")}`,
    "rerun crosscheck init --remove once that is fixed — the files already changed have nothing left to remove",
    "",
  ].join("\n");

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
  const targets = await removalTargets(await projectWiringFiles(root, options.cursor));
  // Before anything is read: a "project" file that IS a user-level one
  // ($HOME as the work tree, or a link into ~/.claude) is the install
  // doctor said to keep (review 2026-10-05).
  const collision = await findUserLevelCollision(
    targets.map((target) => target.path),
    env,
  );
  if (collision !== null) {
    return {
      stdout: `${collisionSentence(collision, root)}; \`crosscheck init --global --remove\` is the user-level removal\n`,
      exitCode: EXIT_ABORTED,
    };
  }
  const planned = await planAll(targets);
  if (!planned.ok) {
    return { stdout: `${planned.refusal}\n`, exitCode: EXIT_ABORTED };
  }
  const plans = await saveOriginals(planned.plans, root, removalBackupDir(env, root));
  const applied = await applyAll(plans);
  if (!applied.ok) {
    return { stdout: failureReport(applied), exitCode: EXIT_FAIL };
  }
  const notes = await Promise.all(plans.map((plan) => teamChangeNote(root, plan)));
  return {
    stdout: [
      ...plans.map(planLine),
      ...notes.flat(),
      ...(await leftInPlaceLines(root, env, options.cursor)),
      REMOVE_RESTART_LINE,
      "",
    ].join("\n"),
    exitCode: EXIT_OK,
  };
};
