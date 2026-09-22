/**
 * DID THE CODE MOVE UNDER THIS CLAIM — against git, on a real repository.
 *
 * The axis is git ancestry (`X..<ref>`), never a wall clock: "a claim is old"
 * is not evidence "the code moved", and the one existing staleness check
 * (`checkSolvedFileDrift`) asks `--since=<iso>` about a WORK CONTEXT's files
 * on the solved branch only. This asks about ONE claim's own surface from the
 * commit it was observed at.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { MAX_CLAIM_SURFACE_PATHS } from "@crosscheck/schema";

import { checkClaimDrift } from "../src/git/claim-drift.ts";
import { git, makeRepo, writeRepoFile } from "./helpers.ts";

const paths: string[] = [];

interface Fixture {
  readonly root: string;
  /** HEAD before either later commit — the "observed at" point. */
  readonly base: string;
}

const revParse = async (root: string, ref: string): Promise<string> => {
  const proc = Bun.spawn({
    cmd: ["git", "rev-parse", ref],
    cwd: root,
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  });
  return (await new Response(proc.stdout).text()).trim();
};

/**
 * A repo whose `main` moved twice over `src/auth.ts` after `base`, and once
 * over an unrelated file. `main` is used as the default ref directly: the
 * production caller resolves `origin/<default>` first, and a fixture with a
 * remote would buy nothing this module is responsible for.
 */
const fixture = async (label: string): Promise<Fixture> => {
  const root = await makeRepo(label);
  paths.push(root);
  await writeRepoFile(root, "src/auth.ts", "export const verify = 1;\n");
  await writeRepoFile(root, "src/unrelated.ts", "export const x = 1;\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "surface"]);
  const base = await revParse(root, "HEAD");
  await writeRepoFile(root, "src/auth.ts", "export const verify = 2;\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "rotate the signing key"]);
  await writeRepoFile(root, "src/auth.ts", "export const verify = 3;\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "rewrite verify"]);
  await writeRepoFile(root, "src/unrelated.ts", "export const x = 2;\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "unrelated"]);
  return { root, base };
};

afterAll(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
});

describe("checkClaimDrift", () => {
  test("a moved surface is changed and names the commits, newest first", async () => {
    // Arrange
    const { root, base } = await fixture("claim-drift-changed");
    const newest = await revParse(root, "HEAD~1");
    const older = await revParse(root, "HEAD~2");

    // Act
    const drift = await checkClaimDrift(root, "main", base, ["src/auth.ts"]);

    // Assert: both commits, newest first, abbreviated — and nothing else. A
    // downgrade that says "changed" naming nothing is AT-2's missing half.
    expect(drift.result).toBe("changed");
    expect(drift.touchingCommits.length).toBe(2);
    expect(newest.startsWith(drift.touchingCommits[0] ?? "no")).toBe(true);
    expect(older.startsWith(drift.touchingCommits[1] ?? "no")).toBe(true);
    expect(drift.touchingTotal).toBe(2);
  });

  test("an untouched surface is unchanged and names nothing", async () => {
    // Arrange: `src/unrelated.ts` moved once, but only AFTER the two auth
    // commits — so a claim observed at HEAD~1 over auth.ts has not drifted.
    const { root } = await fixture("claim-drift-unchanged");
    const afterAuth = await revParse(root, "HEAD~1");

    // Act
    const drift = await checkClaimDrift(root, "main", afterAuth, ["src/auth.ts"]);

    // Assert
    expect(drift.result).toBe("unchanged");
    expect(drift.touchingCommits).toEqual([]);
    expect(drift.touchingTotal).toBe(0);
  });

  test("a commit this clone does not have is unknown, never current", async () => {
    // Arrange: a teammate's unpushed commit. git exits non-zero on an unknown
    // object, and that is UNKNOWN — never an error and never "unchanged".
    const { root } = await fixture("claim-drift-unknown-object");

    // Act
    const drift = await checkClaimDrift(root, "main", "0123456789abcdef", [
      "src/auth.ts",
    ]);

    // Assert
    expect(drift.result).toBe("unknown");
    expect(drift.touchingCommits).toEqual([]);
  });

  test("a path this clone has never held is unknown, not unchanged", async () => {
    // Arrange: get_diagnosis serves CROSS-REPO reads, where the author's file
    // paths need not exist in the reader's checkout at all. `rev-list` prints
    // nothing for both "untouched" and "no such path", so the second call is
    // what separates them — the null-on-empty trap solved-staleness.ts spends
    // its own second call to dodge.
    const { root, base } = await fixture("claim-drift-foreign-path");

    // Act
    const drift = await checkClaimDrift(root, "main", base, [
      "packages/other-repo/src/thing.ts",
    ]);

    // Assert
    expect(drift.result).toBe("unknown");
  });

  test("a flag-shaped pathspec never reaches git", async () => {
    // Arrange: nothing flag- or prose-shaped may reach git (the
    // landed-evidence rule). With every path filtered there is no question
    // left to ask, so the answer is unknown.
    const { root, base } = await fixture("claim-drift-flag-path");

    // Act
    const drift = await checkClaimDrift(root, "main", base, [
      "--output=/tmp/pwned",
    ]);

    // Assert
    expect(drift.result).toBe("unknown");
    expect(drift.pathsChecked).toBe(0);
  });

  test("an observed commit that is not an object name never reaches git", async () => {
    // Arrange: `crosscheck conference` registers a session with the literal
    // "conference", and the hub stores any non-empty string.
    const { root } = await fixture("claim-drift-label-commit");

    // Act
    const drift = await checkClaimDrift(root, "main", "conference", [
      "src/auth.ts",
    ]);

    // Assert
    expect(drift.result).toBe("unknown");
  });

  test("more touching commits than the cap are counted but not all named", async () => {
    // Arrange: D6's bound is 5 named hashes. The COUNT still has to be real,
    // or the downgrade says "and more" where it could say "and 3 more".
    const root = await makeRepo("claim-drift-cap");
    paths.push(root);
    await writeRepoFile(root, "src/hot.ts", "export const v = 0;\n");
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-m", "surface"]);
    const base = await revParse(root, "HEAD");
    for (let index = 1; index <= 8; index += 1) {
      await writeRepoFile(root, "src/hot.ts", `export const v = ${String(index)};\n`);
      await git(root, ["add", "-A"]);
      await git(root, ["commit", "-m", `touch ${String(index)}`]);
    }

    // Act
    const drift = await checkClaimDrift(root, "main", base, ["src/hot.ts"]);

    // Assert
    expect(drift.result).toBe("changed");
    expect(drift.touchingCommits.length).toBe(5);
    expect(drift.touchingTotal).toBe(8);
  });
  test("a surface cut by the cap can never vouch for the files it skipped", async () => {
    // THE DEFAULT PATH, not an edge case. `contextTargets` slices a work
    // context's file targets to MAX_CLAIM_SURFACE_PATHS while the hub serves
    // up to DIAGNOSIS_MAX_TARGETS of them ordered by value, so a tree with 40
    // targets always keeps the alphabetically FIRST 30 — and a rewrite past
    // the cut is invisible to every pull. `context_targets` is the default
    // basis: an agent that passes no `affectedPaths` lands here.
    //
    // Before the completeness guard this answered `unchanged`, the hub
    // derived `current`, and the claim kept the unsolicited substance lane
    // rendering "those files have not changed since" — about a file that had
    // been rewritten. Missing evidence moving a claim from `unknown` to
    // `current` is principle 5 inverted.
    const root = await makeRepo("claim-drift-cut");
    paths.push(root);
    const surface = Array.from(
      { length: MAX_CLAIM_SURFACE_PATHS + 10 },
      (_unused, index) => `src/f${String(index).padStart(3, "0")}.ts`,
    );
    for (const file of surface) {
      await writeRepoFile(root, file, "export const v = 0;\n");
    }
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-m", "surface"]);
    const base = await revParse(root, "HEAD");

    // Only the LAST path moves — the one the cut drops.
    const moved = surface[surface.length - 1] ?? "";
    await writeRepoFile(root, moved, "export const v = 1;\n");
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-m", "rewrite past the cut"]);

    // Act
    const drift = await checkClaimDrift(root, "main", base, surface);

    // Assert: withheld, and the narrowing is visible in the numbers.
    expect(drift.result).toBe("unknown");
    expect(drift.pathsChecked).toBe(MAX_CLAIM_SURFACE_PATHS);
    expect(drift.pathsGiven).toBe(surface.length);

    // The control, and the asymmetry principle 5 describes: a COMPLETE look
    // at the same repo still answers, and a narrowed look that FINDS a change
    // still answers — a subset can miss a change, never invent one.
    const whole = await checkClaimDrift(root, "main", base, [moved]);
    expect(whole.result).toBe("changed");
    const untouched = await checkClaimDrift(root, "main", base, [surface[0] ?? ""]);
    expect(untouched.result).toBe("unchanged");
  });
});
