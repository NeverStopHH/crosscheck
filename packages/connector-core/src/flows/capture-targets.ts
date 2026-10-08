/**
 * `captureFileTargets` + `captureFailure` (DESIGN-agent-agnostic.md §1.3) —
 * the post-tool-use recipes as extracted functions:
 *
 *   - targets: `toRepoRelative` → denylist → seen-set → secret-scan →
 *     generated-target classification → spool `target` records, capped at
 *     MAX_TARGETS_PER_INVOCATION;
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
import { sessionSlug } from "../config/paths.ts";
import { isDenied, isDeniedUnlessAuthoritative, resolveDenylist } from "../capture/denylist.ts";
import type { DenylistConfig } from "../capture/denylist.ts";
import { isAuthoritative, readAuthoritativeGenerated } from "../capture/authoritative-generated.ts";
import type { AuthoritativeGenerated } from "../capture/authoritative-generated.ts";
import { fingerprint } from "../capture/fingerprint.ts";
import {
  NO_GENERATED,
  classifyGenerated,
  tallyGenerated,
  wireGeneratedSignal,
} from "../capture/generated.ts";
import type { GeneratedClassification, GeneratedTally } from "../capture/generated.ts";
import { targetRecord } from "../capture/records.ts";
import type { Producer, TargetSource } from "../capture/records.ts";
import { ALLOCATION_FAILED, seqAt, withSeq } from "../capture/seq.ts";
import { containsSecret } from "../capture/secret-scan.ts";
import { toRepoRelative } from "../capture/target-paths.ts";
import { appendRecords } from "../spool/append.ts";
import { recordDrop } from "../spool/drops.ts";
import type { SeqField } from "@crosscheck/schema";
import type { SeqRange } from "../state/session-state.ts";

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
   * `repoRoot`. NO CALLER OMITS IT ANY MORE — `flows/capture-touched-files.ts`
   * builds this call for every host-reported edit and precomputes the map once
   * per event (capture/touched-root.ts), so the git cost is paid at most once
   * per NEW worktree root per session and never per tool call;
   * `flows/capture-git-touches.ts` builds the only other one and passes the
   * single root git answered in. The option survives because it is the seam
   * the unit tests drive, and because an ABSENT hook and one returning null
   * must stay different answers.
   */
  readonly resolveRoot?: (path: string) => string | null;
  /**
   * The block of positions this invocation reserved, allocated by the CALLER
   * before this flow runs. Record i takes position `from + i`; an absent or
   * null block makes every record carry `allocation_failed`, which is the
   * honest answer and not a silence.
   *
   * ALLOCATED BY THE CALLER, not here, for the reason spec 01 §3.6 gets wrong:
   * a hook emits targets AND a failure fingerprint from one invocation, and a
   * block taken per flow would give the two overlapping positions. One block,
   * one acquisition, two consumers.
   */
  readonly seq?: SeqRange | null;
  /**
   * Whether the host event was an EDIT (docs/1.0/loss-accounting.md §4.3).
   * The two refusals this flow books as drops — the per-call cap and the
   * secret scan — are losses of a file touch only when the touch was an
   * edit: an ACP `read` arrives with `locations` too, and a read the cap
   * cut is not a lost edit. Defaults to true, the shape of every host event
   * that reaches this flow except the ACP read; the same argument
   * `withCaptureBookkeeping` makes for its counters.
   */
  readonly editFired?: boolean;
}

interface CaptureRefusals {
  /** Paths never examined because the cap was reached before them. */
  readonly capped: number;
  /** Paths whose repo-relative id the secret scan refused. */
  readonly secretPaths: number;
}

/**
 * THE CAP AND THE SCAN USED TO BE A `break` AND A `continue` (loss-accounting
 * §3 rows 8 and 9): the file touch was gone and nothing counted it. Both are
 * now `.drops` lines, so append.ts's contract — on disk, delivered, or
 * COUNTED — holds for capture as well. `capped` counts every path past the
 * cut, which may include paths the denylist or the seen-set would have
 * skipped anyway: over-counting a loss is the honest direction to fail in.
 */
const recordCaptureRefusals = async (
  input: CaptureFileTargetsInput,
  refusals: CaptureRefusals,
): Promise<void> => {
  if (input.editFired === false) {
    return;
  }
  const slug = sessionSlug(input.hostSessionKey);
  await recordDrop(input.home, input.repoKey, slug, refusals.capped, "capture-capped", input.now);
  await recordDrop(input.home, input.repoKey, slug, refusals.secretPaths, "secret-path", input.now);
};

export interface CapturedFileTargets {
  /** The repo-relative paths spooled — the caller folds them into its seen-set. */
  readonly captured: readonly string[];
  /** How each spooled path was classified (capture/generated.ts), counted. */
  readonly generated: GeneratedTally;
}

interface Collected {
  readonly value: string;
  readonly root: string;
}

/**
 * Each root's `authoritativeGenerated`, read once per call (capture/
 * authoritative-generated.ts): the denylist bypass below and the
 * classification both need it, and a path's declaration is the one committed
 * at the root of the worktree it lives in.
 */
const declarationsByRoot = (): ((root: string) => Promise<AuthoritativeGenerated>) => {
  const read = new Map<string, Promise<AuthoritativeGenerated>>();
  return (root) => {
    const known = read.get(root);
    if (known !== undefined) {
      return known;
    }
    const pending = readAuthoritativeGenerated(root);
    read.set(root, pending);
    return pending;
  };
};

/**
 * THE GENERATED-TARGET RULE, applied to the paths this call is about to
 * spool and to no other: they are NEW to the session (the seen-set ran
 * first), so a file is classified once per session however often it is
 * edited, and the attribute cache carries the answer across sessions. Grouped
 * by root, because a path's attributes are those of the worktree it lives in.
 *
 * A mechanically generated, non-authoritative target is KEPT and labelled,
 * never dropped: `suspect` and coverage still see the touch, and only the
 * hub's overlap reads leave it out.
 */
const classifyCollected = async (
  home: string,
  collected: readonly Collected[],
  declaredAt: (root: string) => Promise<AuthoritativeGenerated>,
): Promise<ReadonlyMap<string, GeneratedClassification>> => {
  const byRoot = new Map<string, string[]>();
  for (const entry of collected) {
    byRoot.set(entry.root, [...(byRoot.get(entry.root) ?? []), entry.value]);
  }
  const answers = await Promise.all(
    [...byRoot].map(async ([root, paths]) =>
      classifyGenerated({ home, root, paths, authoritative: await declaredAt(root) }),
    ),
  );
  return new Map(answers.flatMap((answer) => [...answer]));
};

/**
 * Dropped by the denylist — unless the file is authoritative (declared by the
 * repo, or a contract or migration) and only generated-output entries drop it
 * (capture/denylist.ts isDeniedUnlessAuthoritative). The declaration is read
 * only for a path the denylist would drop, so an ordinary edit costs no extra
 * read.
 */
const isDropped = async (
  relativePath: string,
  patterns: readonly string[],
  root: string,
  declaredAt: (root: string) => Promise<AuthoritativeGenerated>,
): Promise<boolean> =>
  isDenied(relativePath, patterns) &&
  isDeniedUnlessAuthoritative(relativePath, patterns, isAuthoritative(relativePath, await declaredAt(root)));

/**
 * Filters, classifies, spools, and returns the repo-relative paths captured —
 * the caller folds them into its session state (`withSeenTargets`) — with the
 * generated-target counters its state write books (`withCaptureBookkeeping`).
 */
export const captureFileTargets = async (
  input: CaptureFileTargetsInput,
): Promise<CapturedFileTargets> => {
  const patterns = resolveDenylist(input.denylist ?? undefined);
  const declaredAt = declarationsByRoot();
  const seen = new Set(input.seenTargets);
  const collected: Collected[] = [];
  let secretPaths = 0;
  let examined = 0;
  for (const path of input.paths) {
    if (collected.length >= MAX_TARGETS_PER_INVOCATION) {
      break;
    }
    examined += 1;
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
    if (relativePath === null || (await isDropped(relativePath, patterns, root, declaredAt))) {
      continue;
    }
    if (containsSecret(relativePath)) {
      secretPaths += 1;
      continue;
    }
    if (seen.has(relativePath)) {
      continue;
    }
    seen.add(relativePath);
    collected.push({ value: relativePath, root });
  }
  await recordCaptureRefusals(input, {
    capped: input.paths.length - examined,
    secretPaths,
  });
  if (collected.length === 0) {
    return { captured: [], generated: NO_GENERATED };
  }
  const classified = await classifyCollected(input.home, collected, declaredAt);
  await appendRecords(
    input.home,
    input.repoKey,
    input.hostSessionKey,
    collected.map(({ value }, index) =>
      withSeq(
        targetRecord(
          input.workContextId,
          "file",
          value,
          input.producer,
          input.now,
          input.source ?? "tool_edit",
          wireGeneratedSignal(classified.get(value)),
          classified.get(value) === "authoritative",
        ),
        seqAt(input.seq, index),
      ),
    ),
    input.now,
  );
  return {
    captured: collected.map(({ value }) => value),
    generated: tallyGenerated(collected.map(({ value }) => classified.get(value) ?? "unknown")),
  };
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
  /**
   * ONE position, already resolved — the fingerprint shares the caller's block
   * with the targets beside it, and only the caller knows which slot is its.
   */
  readonly seq?: SeqField;
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
      withSeq(
        targetRecord(
          input.workContextId,
          "error_fingerprint",
          value,
          input.producer,
          input.now,
        ),
        input.seq ?? ALLOCATION_FAILED,
      ),
    ],
    input.now,
  );
  return value;
};
