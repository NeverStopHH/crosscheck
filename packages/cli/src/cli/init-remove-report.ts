/**
 * What `crosscheck init --remove` says once it has changed the files: which of
 * them teammates share, what was left in place on purpose, what STILL wires
 * this repo, and — only when every place it can know about was read and found
 * clean — that sessions here now load no crosscheck hooks (review 2026-10-05:
 * that sentence was printed while Cursor entries, an unrecognised launcher's
 * hooks or an unreadable ~/.claude/settings.json still wired the repo).
 */
import { relative } from "node:path";

import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { repoConfigPath } from "@crosscheck/connector-core/config/repo-config.ts";
import { isPathTracked } from "@crosscheck/connector-core/git/check-ignore.ts";
import { unreadableClause } from "./init-io.ts";
import { planLeftovers, planLine, unrecognisedLine } from "./init-remove-plan.ts";
import type { ApplyOutcome, FilePlan } from "./init-remove-plan.ts";
import { cursorTargets, isClean, readWiringState, removalTargets } from "./wiring-removal.ts";
import type { WiringState } from "./wiring-removal.ts";
import { projectCursorDir, userWiringFiles } from "./wiring-scope.ts";

/**
 * A changed file git TRACKS is a change every teammate receives once it is
 * committed — the opposite of the ignored project copy this command was built
 * for. Said per file, with both ways out, because only the developer knows
 * whether the team's install should go.
 */
export const teamChangeNote = async (root: string, plan: FilePlan): Promise<readonly string[]> => {
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

interface StateWording {
  /** The line for files still holding crosscheck's entries, given "path (what)" items. */
  readonly wired: (files: string) => string;
  /** What an unreadable file leaves unknown. */
  readonly unknown: string;
}

const stateLines = (state: WiringState, wording: StateWording): readonly string[] => [
  ...(state.wired.length === 0
    ? []
    : [wording.wired(state.wired.map((file) => `${file.path} (${file.removed})`).join(", "))]),
  ...state.unrecognised.flatMap((file) => unrecognisedLine(file.path, file.commands)),
  ...state.unreadable.map(
    (file) => `${unreadableClause(file.path, file.reason)} — ${wording.unknown}`,
  ),
];

const CURSOR_WORDING: StateWording = {
  wired: (files) =>
    `left crosscheck's cursor entries in place — ${files}: Cursor sessions here still load them; \`crosscheck init --remove --cursor\` removes them too`,
  unknown: "whether it still holds crosscheck's cursor entries is unknown",
};

const USER_WORDING: StateWording = {
  wired: (files) =>
    `left the user-level install in place: ${files} — it keeps wiring this repo and every other checkout on this machine`,
  unknown: "left untouched; whether it still wires this repo is unknown",
};

/** The one sentence that says nothing wires the repo — printed only once verified. */
const VERIFIED_UNWIRED_LINE =
  "no user-level install either, and nothing of crosscheck's is left in this repo's wiring: sessions starting here now load no crosscheck hooks — `crosscheck init --global` wires every checkout on this machine";

const NO_USER_LEVEL_LINE =
  "no user-level install — what still wires this repo is named above";

/**
 * Everything the run left, read back rather than assumed: the repo's own
 * leftovers, the team's repo connection, the Cursor pair a run without
 * --cursor did not touch, and every user-level file.
 */
export const afterRunLines = async (
  root: string,
  env: Env,
  cursor: boolean,
  plans: readonly FilePlan[],
): Promise<readonly string[]> => {
  const connection = repoConfigPath(root);
  const leftovers = plans.flatMap(planLeftovers);
  const cursorState = cursor
    ? null
    : await readWiringState(await cursorTargets(await projectCursorDir(root)));
  const userState = await readWiringState(await removalTargets(userWiringFiles(env)));
  const verified =
    leftovers.length === 0 && (cursorState === null || isClean(cursorState)) && isClean(userState);
  return [
    ...leftovers,
    ...((await Bun.file(connection).exists())
      ? [`left ${connection} in place — the team's repo connection; init --remove never touches it`]
      : []),
    ...(cursorState === null ? [] : stateLines(cursorState, CURSOR_WORDING)),
    ...stateLines(userState, USER_WORDING),
    ...(verified ? [VERIFIED_UNWIRED_LINE] : isClean(userState) ? [NO_USER_LEVEL_LINE] : []),
  ];
};

/** A run that stopped part-way: what changed, where it stopped, what did not. */
export const failureReport = (outcome: ApplyOutcome & { readonly ok: false }): string =>
  [
    `stopped at ${outcome.failed.path}: ${outcome.error}`,
    ...(outcome.applied.length === 0
      ? ["nothing had been changed before that — the repo is as it was"]
      : ["already changed before that:", ...outcome.applied.map((plan) => `  ${planLine(plan)}`)]),
    `not changed: ${[outcome.failed, ...outcome.pending].map((plan) => plan.path).join(", ")}`,
    "rerun crosscheck init --remove once that is fixed — the files already changed have nothing left to remove",
    "",
  ].join("\n");
