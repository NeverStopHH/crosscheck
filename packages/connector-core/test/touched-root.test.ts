/**
 * Which root governs a TOUCHED file — the resolver's own rules (finding #17).
 *
 * The hook-level proof lives in connector-claude/test/worktree-capture.test.ts
 * (real hooks, real git worktrees). This file drives the module through its
 * injected seams instead, so the three answers it must never confuse — capture,
 * FOREIGN drop, OUTSIDE-ROOT drop — and the cost it must never pay twice are
 * pinned without a git spawn and without a temp repo:
 *
 *   - the free D2 candidate (`ctx.identity.root`) is the CWD's root, not the
 *     file's, so it governs only the paths it CONTAINS;
 *   - an UNRESOLVED root is an unknown, not a second repo: outside-root, never
 *     foreign (doctor explains foreign drops as "your second connected repo");
 *   - the per-session cache HIT path is the reason the per-tool hook stays
 *     inside its budget, so the resolution COUNT is asserted, not the clock;
 *   - a cached unknown is retried a bounded number of times, so one missed git
 *     deadline does not exile a healthy worktree for the session.
 */
import { describe, expect, test } from "bun:test";

import { MAX_WORKTREE_ROOT_RESOLVE_ATTEMPTS } from "../src/constants.ts";
import { resolveTouchedRoots } from "../src/capture/touched-root.ts";
import type {
  KnownWorktreeRoot,
  ResolveTouchedRootsInput,
} from "../src/capture/touched-root.ts";

const REPO_ID = "github.com/acme/api";
const OTHER_REPO_ID = "github.com/acme/web";
const ROOT_A = "/cx-touched-root/lab";
const ROOT_B = "/cx-touched-root/lab-featB";
const ROOT_C = "/cx-touched-root/lab-featC";
const ROOT_OTHER = "/cx-touched-root/other";

/**
 * Roots under a directory that does not exist: `realpathBestEffort` walks up
 * to `/` and hands the spelling straight back, so every comparison here is
 * lexical and identical on macOS and in the Linux container.
 */
const rootOf = (path: string): string | null =>
  [ROOT_A, ROOT_B, ROOT_C, ROOT_OTHER].find(
    (root) => path === root || path.startsWith(`${root}/`),
  ) ?? null;

interface Calls {
  readonly walked: string[];
  readonly resolved: string[];
}

const run = async (
  input: Pick<ResolveTouchedRootsInput, "paths" | "cwd"> & {
    readonly identityRoot: string;
    readonly identityRepoId?: string;
    readonly knownWorktreeRoots?: readonly KnownWorktreeRoot[];
    readonly repoIdOf?: (root: string) => string | null;
  },
): Promise<{
  readonly resolution: Awaited<ReturnType<typeof resolveTouchedRoots>>;
  readonly calls: Calls;
}> => {
  const calls: Calls = { walked: [], resolved: [] };
  const repoIdOf =
    input.repoIdOf ??
    ((root: string): string | null => (root === ROOT_OTHER ? OTHER_REPO_ID : REPO_ID));
  const resolution = await resolveTouchedRoots({
    paths: input.paths,
    cwd: input.cwd,
    sessionRepoRoot: ROOT_A,
    sessionRepoId: REPO_ID,
    identityRoot: input.identityRoot,
    identityRepoId: input.identityRepoId ?? REPO_ID,
    knownWorktreeRoots: input.knownWorktreeRoots ?? [],
    resolveConnectedRoot: async (_cwd, path) => {
      calls.walked.push(path);
      return rootOf(path);
    },
    resolveRootRepoId: async (root) => {
      calls.resolved.push(root);
      return repoIdOf(root);
    },
  });
  return { resolution, calls };
};

describe("the free D2 candidate governs only the paths it contains", () => {
  test("a cwd in worktree B does not swallow a file in worktree C", async () => {
    // Arrange: session bound to A, hook cwd in worktree B, file in worktree C
    const file = `${ROOT_C}/src/auth/refresh.ts`;

    // Act
    const { resolution, calls } = await run({
      paths: [file],
      cwd: ROOT_B,
      identityRoot: ROOT_B,
    });

    // Assert: C governs the file — the walk ran instead of B being assumed
    expect([...resolution.rootByPath]).toEqual([[file, ROOT_C]]);
    expect(resolution.outsideDrops).toBe(0);
    expect(resolution.foreignDrops).toBe(0);
    expect(calls.walked).toEqual([file]);
    expect(resolution.firstResolvedRoot).toBe(ROOT_C);
  });

  test("a cwd in worktree B still books a DIFFERENT repo as a foreign drop", async () => {
    // Arrange: same geometry, but the file belongs to a second connected repo
    const file = `${ROOT_OTHER}/src/app.ts`;

    // Act
    const { resolution } = await run({
      paths: [file],
      cwd: ROOT_B,
      identityRoot: ROOT_B,
    });

    // Assert: foreign stays foreign — never mis-booked as outside-root
    expect(resolution.foreignDrops).toBe(1);
    expect(resolution.outsideDrops).toBe(0);
    expect([...resolution.rootByPath]).toEqual([]);
  });

  test("a file the D2 root DOES contain still costs no walk", async () => {
    // Arrange: the shape the shortcut exists for — cwd and file both in B
    const file = `${ROOT_B}/src/two.ts`;

    // Act
    const { resolution, calls } = await run({
      paths: [file],
      cwd: ROOT_B,
      identityRoot: ROOT_B,
    });

    // Assert: captured against B, with neither a walk nor an identity spawn
    expect([...resolution.rootByPath]).toEqual([[file, ROOT_B]]);
    expect(calls.walked).toEqual([]);
    expect(calls.resolved).toEqual([]);
  });
});

describe("an unresolvable root is an unknown, not a second repo", () => {
  test("a root whose identity does not resolve is an outside-root drop", async () => {
    // Arrange: the walk finds C (it carries the committed config), but its
    // identity does not resolve — a pruned linked worktree, or a git deadline
    const file = `${ROOT_C}/src/x.ts`;

    // Act
    const { resolution } = await run({
      paths: [file],
      cwd: ROOT_A,
      identityRoot: ROOT_A,
      repoIdOf: () => null,
    });

    // Assert: counted as outside-root; the foreign line stays truthful
    expect(resolution.outsideDrops).toBe(1);
    expect(resolution.foreignDrops).toBe(0);
    expect(resolution.firstResolvedRoot).toBeNull();
  });

  test("the unknown is retried, then stands", async () => {
    // Arrange: the same root cached as unknown after one spent attempt
    const file = `${ROOT_C}/src/x.ts`;
    const cachedAfter = (attempts: number): readonly KnownWorktreeRoot[] => [
      { root: ROOT_C, repoId: null, attempts },
    ];

    // Act: git is healthy again on the retry, and the root resolves
    const retried = await run({
      paths: [file],
      cwd: ROOT_A,
      identityRoot: ROOT_A,
      knownWorktreeRoots: cachedAfter(1),
    });
    // …and a root whose attempt budget is spent is never resolved again
    const settled = await run({
      paths: [file],
      cwd: ROOT_A,
      identityRoot: ROOT_A,
      knownWorktreeRoots: cachedAfter(MAX_WORKTREE_ROOT_RESOLVE_ATTEMPTS),
      repoIdOf: () => null,
    });

    // Assert
    expect(retried.calls.resolved).toEqual([ROOT_C]);
    expect([...retried.resolution.rootByPath]).toEqual([[file, ROOT_C]]);
    expect(retried.resolution.newlyResolved).toEqual([
      { root: ROOT_C, repoId: REPO_ID, attempts: 2 },
    ]);
    expect(settled.calls.resolved).toEqual([]);
    expect(settled.resolution.outsideDrops).toBe(1);
  });
});

describe("the per-session root cache is the budget (finding #17)", () => {
  test("two touches of one new root cost exactly one identity resolution", async () => {
    // Arrange: two files in the same not-yet-known worktree
    const first = `${ROOT_C}/src/one.ts`;
    const second = `${ROOT_C}/src/two.ts`;

    // Act
    const { resolution, calls } = await run({
      paths: [first, second],
      cwd: ROOT_A,
      identityRoot: ROOT_A,
    });

    // Assert: both captured, git consulted once — not once per path
    expect(resolution.rootByPath.size).toBe(2);
    expect(calls.resolved).toEqual([ROOT_C]);
    expect(resolution.newlyResolved).toEqual([
      { root: ROOT_C, repoId: REPO_ID, attempts: 1 },
    ]);
  });

  test("a root the session already knows costs no identity resolution at all", async () => {
    // Arrange: the cache as a later hook of the same session reads it
    const file = `${ROOT_C}/src/one.ts`;

    // Act
    const { resolution, calls } = await run({
      paths: [file],
      cwd: ROOT_A,
      identityRoot: ROOT_A,
      knownWorktreeRoots: [{ root: ROOT_C, repoId: REPO_ID, attempts: 1 }],
    });

    // Assert: the HIT path — no spawn, nothing new to write back
    expect([...resolution.rootByPath]).toEqual([[file, ROOT_C]]);
    expect(calls.resolved).toEqual([]);
    expect(resolution.newlyResolved).toEqual([]);
  });

  test("a known FOREIGN root is final: cached once, never re-resolved", async () => {
    // Arrange: the second connected repo, already judged this session
    const file = `${ROOT_OTHER}/src/app.ts`;

    // Act
    const { resolution, calls } = await run({
      paths: [file],
      cwd: ROOT_A,
      identityRoot: ROOT_A,
      knownWorktreeRoots: [{ root: ROOT_OTHER, repoId: OTHER_REPO_ID, attempts: 1 }],
    });

    // Assert
    expect(resolution.foreignDrops).toBe(1);
    expect(calls.resolved).toEqual([]);
  });
});
