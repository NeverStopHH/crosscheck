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
import type { Producer } from "../capture/records.ts";
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
  readonly now: Date;
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
    const relativePath = await toRepoRelative(input.repoRoot, input.cwd, path);
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
        targetRecord(input.workContextId, "file", value, input.producer, input.now),
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
