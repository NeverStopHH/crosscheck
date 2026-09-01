/**
 * `captureFileTargets` + `captureFailure` (DESIGN-agent-agnostic.md §1.3) —
 * the post-tool-use recipes as extracted functions:
 *
 *   - targets: `toRepoRelative` → denylist → seen-set → secret-scan → spool
 *     `target` records, capped at MAX_TARGETS_PER_INVOCATION;
 *   - failure: `fingerprint()` (which refuses secrets and no-signal text) →
 *     spool one `error_fingerprint` target.
 *
 * EXTRACTED FROM `connector-claude/src/hooks/post-tool-use.ts`, not invented
 * — the hook calls these now, so the derivation every connector joins on
 * (repo-relative path, fingerprint) has exactly one spelling. Host-specific
 * parsing (which payload fields carry paths, what counts as a failure
 * response) stays in each connector.
 *
 * SESSION STATE IS THE CALLER'S: these flows filter against the seen-set
 * passed in but never write it back, because hosts batch their state writes
 * differently (the Claude hook merges seen targets with its heartbeat
 * timestamp in ONE locked update — see its state-race reasoning). A caller
 * that captured targets must follow with `updateSessionState(withSeenTargets)`.
 */
import { MAX_TARGETS_PER_INVOCATION } from "../constants.ts";
import { isDenied, resolveDenylist } from "../capture/denylist.ts";
import type { DenylistConfig } from "../capture/denylist.ts";
import { fingerprint } from "../capture/fingerprint.ts";
import { targetRecord } from "../capture/records.ts";
import type { Producer, TargetSource } from "../capture/records.ts";
import { containsSecret } from "../capture/secret-scan.ts";
import { toRepoRelative } from "../capture/target-paths.ts";
import { appendRecords } from "../spool/append.ts";

export interface CaptureFileTargetsInput {
  readonly home: string;
  readonly repoKey: string;
  readonly hostSessionKey: string;
  readonly repoRoot: string;
  /** Relative paths resolve against this, exactly as the host saw them. */
  readonly cwd: string;
  readonly paths: readonly string[];
  readonly denylist: DenylistConfig | null;
  readonly seenTargets: readonly string[];
  readonly workContextId: string;
  readonly producer: Producer;
  /**
   * WHICH lane saw these paths (regression-guard Stage 1). Defaults to the
   * tool lane, because that is what every caller of this flow was before the
   * git lane existed; `captureGitTouches` passes "git_diff".
   */
  readonly source?: TargetSource;
  readonly now: Date;
  /**
   * Per-path root override (trial finding #17): resolves the root a touched
   * file's repo-relative id is derived against — a linked worktree of the same
   * repo instead of the session's checkout — or null to DROP the path (a
   * foreign or outside-root touch the caller has already counted). Omitting it
   * keeps the pre-#17 single-root behaviour: every path resolves against
   * `repoRoot`. NO CONNECTOR OMITS IT ANY MORE — `flows/capture-touched-files.ts`
   * is the one place that builds this call, and it precomputes the map once per
   * event (capture/touched-root.ts) so the git cost is paid at most once per NEW
   * worktree root per session, never per tool call. The option survives because
   * it is the seam the unit tests drive, and because an ABSENT hook and one
   * returning null must stay different answers.
   */
  readonly resolveRoot?: (path: string) => string | null;
}

/**
 * Filters, spools, and returns the repo-relative paths captured — the caller
 * folds them into its session state (`withSeenTargets`).
 */
export const captureFileTargets = async (
  input: CaptureFileTargetsInput,
): Promise<readonly string[]> => {
  const patterns = resolveDenylist(input.denylist ?? undefined);
  const seen = new Set(input.seenTargets);
  const collected: string[] = [];
  for (const path of input.paths) {
    if (collected.length >= MAX_TARGETS_PER_INVOCATION) {
      break;
    }
    // The root the file's id is derived against: the caller's per-path
    // override (#17: the file's own worktree) when present, else the session
    // checkout. A null override means the caller already dropped and counted
    // this path (foreign or outside-root), so it is skipped here.
    const root =
      input.resolveRoot === undefined
        ? input.repoRoot
        : input.resolveRoot(path);
    if (root === null) {
      continue;
    }
    const relativePath = await toRepoRelative(root, input.cwd, path);
    if (relativePath === null || isDenied(relativePath, patterns)) {
      continue;
    }
    if (containsSecret(relativePath) || seen.has(relativePath)) {
      continue;
    }
    seen.add(relativePath);
    collected.push(relativePath);
  }
  if (collected.length > 0) {
    await appendRecords(
      input.home,
      input.repoKey,
      input.hostSessionKey,
      collected.map((value) =>
        targetRecord(
          input.workContextId,
          "file",
          value,
          input.producer,
          input.now,
          input.source ?? "tool_edit",
        ),
      ),
      input.now,
    );
  }
  return collected;
};

export interface CaptureFailureInput {
  readonly home: string;
  readonly repoKey: string;
  readonly hostSessionKey: string;
  readonly workContextId: string;
  readonly producer: Producer;
  /** Already host-extracted text; `extractFailureText` is the shared helper. */
  readonly failureText: string;
  readonly now: Date;
}

/**
 * Fingerprints the failure text and spools one `error_fingerprint` target.
 * Returns the fingerprint, or null when `fingerprint()` refused (no signal,
 * or a secret — never a redacted derivative) and nothing was spooled.
 */
export const captureFailure = async (
  input: CaptureFailureInput,
): Promise<string | null> => {
  if (input.failureText.length === 0) {
    return null;
  }
  const value = fingerprint(input.failureText);
  if (value === null) {
    return null;
  }
  await appendRecords(
    input.home,
    input.repoKey,
    input.hostSessionKey,
    [
      targetRecord(
        input.workContextId,
        "error_fingerprint",
        value,
        input.producer,
        input.now,
      ),
    ],
    input.now,
  );
  return value;
};
