/**
 * ONE pre-pass, then the capture — the #17 worktree resolution paired with
 * `captureFileTargets`, so every connector resolves a touched file against
 * the root that governs the FILE and not merely the checkout its session
 * registered at.
 *
 * WHY THIS EXISTS AS A FLOW. The resolver has always been shared and
 * `captureFileTargets` has always taken the hook, but only the Claude hooks
 * passed it: a Cursor session and every ACP agent silently dropped an edit
 * made in a linked worktree of the same repo, uncounted — the H1 shape
 * (371 worktree edits → 0 targets). The twenty lines that join the two are
 * the part a new connector gets SILENTLY wrong: forget the
 * `rootByPath.get(p) ?? null` closure or the `paths.length === 0` guard and
 * every path drops with no counter, which is the original defect wearing a
 * new hat. Here they have one spelling.
 *
 * THE SPREAD IS LOAD-BEARING. `captureFileTargets` keys off
 * `resolveRoot === undefined` to mean "pre-#17 single-root behaviour", so an
 * absent hook and a hook that returns null are DIFFERENT answers: absent is
 * "resolve everything against the session root", null is "the caller already
 * dropped and counted this path". Passing `{ resolveRoot: undefined }`
 * happens to work today and would break the moment that check became an `in`
 * check — hence the spread, never an explicit undefined.
 *
 * SESSION STATE IS STILL THE CALLER'S. This returns both halves — what was
 * captured and the resolution — because the counters, the cache additions and
 * the seen-set belong in the caller's own single locked write, which each host
 * batches differently (state/capture-bookkeeping.ts folds the counters; the
 * refusal to share the write itself is argued there).
 *
 * No connector may call `captureFileTargets` directly. This flow builds that
 * call for every HOST-REPORTED edit, which is what keeps the resolution from
 * being forgotten again. The one other builder is
 * `flows/capture-git-touches.ts`, the Stop-time git lane, and it is not a
 * host event: git prints paths relative to the worktree it ran in and cannot
 * name a file outside it, so that lane resolves every path against that one
 * root and says so at the call site. The directive below is what keeps a
 * THIRD builder from appearing silently — a caller that names no resolution
 * prints MISSING and reddens the claims job.
 *
 * The directive that keeps that true is the pair of line comments below: a
 * block comment cannot hold it, because the glob it needs ends a block
 * comment mid-word.
 */
// VERIFY: for f in $(grep -rl --include='*.ts' 'captureFileTargets({' packages/*/src | sort); do grep -q 'resolveRoot' "$f" && echo "$f ok" || echo "$f MISSING"; done
// PRINTS: packages/connector-core/src/flows/capture-git-touches.ts ok
// PRINTS: packages/connector-core/src/flows/capture-touched-files.ts ok
import { resolveTouchedRoots } from "../capture/touched-root.ts";
import type {
  KnownWorktreeRoot,
  TouchedRootsResolution,
} from "../capture/touched-root.ts";
import { captureFileTargets } from "./capture-targets.ts";
import type { CaptureFileTargetsInput } from "./capture-targets.ts";

export interface CaptureTouchedFilesInput
  extends Omit<CaptureFileTargetsInput, "resolveRoot"> {
  /** The repo this session is bound to; a different one is a foreign drop. */
  readonly sessionRepoId: string;
  /**
   * The already-resolved identity of the event's own directory. On Claude and
   * Cursor it can differ from the session root (the free D2 candidate); on ACP
   * it is the session root itself, so every out-of-checkout path pays the
   * bounded walk and the per-session cache is what keeps that once per root.
   */
  readonly identityRoot: string;
  readonly identityRepoId: string;
  /** The caller's per-session root cache, read at the call's start. */
  readonly knownWorktreeRoots: readonly KnownWorktreeRoot[];
}

export interface CaptureTouchedFilesResult {
  /** Repo-relative ids actually spooled — fold these into the seen-set. */
  readonly captured: readonly string[];
  /**
   * The pre-pass result, or null when there were no paths to resolve. Feed it
   * to `withCaptureBookkeeping` inside the caller's single locked write.
   */
  readonly resolution: TouchedRootsResolution | null;
}

export const captureTouchedFiles = async (
  input: CaptureTouchedFilesInput,
): Promise<CaptureTouchedFilesResult> => {
  const {
    sessionRepoId,
    identityRoot,
    identityRepoId,
    knownWorktreeRoots,
    ...targets
  } = input;
  // Skipped entirely when there is nothing to resolve: an event with no paths
  // must cost no fs work and book no drops.
  const resolution =
    targets.paths.length === 0
      ? null
      : await resolveTouchedRoots({
          paths: targets.paths,
          cwd: targets.cwd,
          sessionRepoRoot: targets.repoRoot,
          sessionRepoId,
          identityRoot,
          identityRepoId,
          knownWorktreeRoots,
        });
  const captured = await captureFileTargets({
    ...targets,
    ...(resolution === null
      ? {}
      : {
          resolveRoot: (path: string): string | null =>
            resolution.rootByPath.get(path) ?? null,
        }),
  });
  return { captured, resolution };
};
