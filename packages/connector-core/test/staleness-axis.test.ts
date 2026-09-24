/**
 * CCB-2 — EXACTLY ONE STALENESS DEFINITION EXISTS, enforced structurally.
 *
 * Spec 02 calls this the load-bearing rule: a claim's authority decays with
 * its CODE, not with a clock. It was also the only one of CCB-1…CCB-10 with
 * no mutation anchor and no guard of its own, and it was broken in the tree
 * while every other CCB test stayed green — because the second definition was
 * spelled `checkSolvedFileDrift`, typed `SolvedFileDrift`, and never once
 * mentioned `stale_at`, which is the string the other guard greps for.
 *
 * THE DEFECT THIS EXISTS TO PREVENT, measured before it was fixed: one
 * `get_diagnosis` pull ran BOTH axes over one clone and printed both, four
 * lines apart, with no precedence rule.
 *
 *   git rev-list --count --since=2026-06-01T11:00:00Z origin/main -- reader.ts
 *   -> 0                      ("have not changed")
 *   git rev-list 35f43c7..origin/main -- reader.ts
 *   -> f15a882                ("have changed")
 *
 * No clock skew, no rebase, no rewritten history: a feature branch merged
 * into the default branch keeps its original committer dates, so `--since`
 * cannot see commits that ancestry can. The clock answer is the REASSURING
 * one, so a reader going top-down meets the calming half first — missing
 * evidence strengthening a conclusion, which principle 5 forbids.
 *
 * SO THE AXIS IS BANNED RATHER THAN REVIEWED. A wall-clock git argument in a
 * `src` module is a red build. The allowlist is empty and should stay empty;
 * adding an entry is a decision about the architecture, which is why it is a
 * visible list here rather than a pattern that could quietly widen.
 */
import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const PACKAGES_ROOT = join(import.meta.dir, "..", "..");
const REPO_ROOT = join(PACKAGES_ROOT, "..");

/**
 * Git's own date filters. Each one answers "what happened in this stretch of
 * TIME", which is never the question a claim's currency asks.
 */
const CLOCK_FLAGS = ["--since", "--until", "--before", "--after"] as const;

/**
 * Modules permitted to ask git a time-shaped question, each with the reason
 * its question is genuinely about TIME rather than about currency.
 *
 * ONE ENTRY, and it earns it. `capture/commit-evidence.ts` asks "who
 * committed in this repo in the last N days" — a question about people's
 * ACTIVITY, which is a stretch of time by definition, and the answer feeds
 * the absence machinery rather than any claim's authority. Its own header
 * already records that `--since` filters on commit date while the in-code
 * window filters on author date, and which way each error runs.
 *
 * Adding a second entry is a decision about the architecture. It is a visible
 * list rather than a pattern for exactly that reason: a regex with an escape
 * hatch widens quietly, a list does not.
 *
 * THE SECOND ENTRY, and the decision it records. `landed-changes/git-queries.ts`
 * asks "which changes ARRIVED on a landing branch in the last two working
 * days" — a notification window a person chose (docs/1.0/landed-changes.md,
 * decision 2), not a claim's currency. It avoids the defect above by
 * construction: it asks on the landing branch's `--first-parent` line, where
 * a merge or squash commit carries the time the change LANDED rather than
 * the feature branch's original dates, and it only ever windows changes the
 * reader already HAS. Whether the reader is MISSING a change is answered by
 * ancestry alone, in the same module, with no clock.
 */
const ALLOWED: readonly string[] = [
  "packages/connector-core/src/capture/commit-evidence.ts",
  "packages/connector-core/src/landed-changes/git-queries.ts",
];

const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

const listSourceFiles = async (root: string): Promise<readonly string[]> => {
  const entries = await readdir(join(root, "src"), {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
};

const hasSrcTree = async (root: string): Promise<boolean> => {
  try {
    await readdir(join(root, "src"), { withFileTypes: true });
    return true;
  } catch {
    return false;
  }
};

const discoverPackageRoots = async (): Promise<readonly string[]> => {
  const entries = await readdir(PACKAGES_ROOT, { withFileTypes: true });
  const roots: string[] = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
    const root = join(PACKAGES_ROOT, entry.name);
    if (await hasSrcTree(root)) {
      roots.push(root);
    }
  }
  return roots.sort();
};

/** Which clock flags this source asks git for, comments stripped first. */
const clockFlagsIn = (source: string): readonly string[] => {
  const clean = withoutComments(source);
  return CLOCK_FLAGS.filter((flag) => clean.includes(flag));
};

describe("CCB-2 — one staleness definition", () => {
  test("no src module asks git a wall-clock question", async () => {
    const roots = await discoverPackageRoots();
    // The walk finding nothing would make the assertion vacuous, so the reach
    // of the walk is asserted first.
    expect(roots.length).toBeGreaterThanOrEqual(7);

    const walked: string[] = [];
    const offenders: string[] = [];
    for (const root of roots) {
      for (const absolute of await listSourceFiles(root)) {
        const file = relative(REPO_ROOT, absolute);
        walked.push(file);
        if (ALLOWED.includes(file)) {
          continue;
        }
        const flags = clockFlagsIn(await Bun.file(absolute).text());
        if (flags.length > 0) {
          offenders.push(`${file}: ${flags.join(", ")}`);
        }
      }
    }

    expect(walked.length).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });

  test("the detector sees a clock flag when one is there", () => {
    // The walk above can only prove an absence. This proves the detector
    // would have spoken — without it, a broken matcher and a clean tree are
    // the same green.
    expect(
      clockFlagsIn(
        'await runGit(["rev-list", "--count", `--since=${iso}`, ref], root);',
      ),
    ).toEqual(["--since"]);
    expect(clockFlagsIn('runGit(["log", "--until=2026-01-01"], root)')).toEqual([
      "--until",
    ]);
    // And it is not simply always-true: ancestry is the permitted shape.
    expect(
      clockFlagsIn(
        'runGit(["rev-list", `${observedAtCommit}..${defaultRef}`], root)',
      ),
    ).toEqual([]);
    // A mention inside a comment is prose, not a call.
    expect(
      clockFlagsIn("// it used to ask --since, and that was the defect"),
    ).toEqual([]);
  });

  test("the axis that replaced it is the one the claims are judged on", async () => {
    // The positive half: `checkClaimDrift` asks ancestry, and the solved
    // block now derives its answer from the record that function feeds rather
    // than measuring anything itself.
    const driftSource = await Bun.file(
      join(PACKAGES_ROOT, "connector-core", "src", "git", "claim-drift.ts"),
    ).text();
    expect(withoutComments(driftSource)).toContain(
      "${observedAtCommit}..${defaultRef}",
    );

    const solvedSource = await Bun.file(
      join(PACKAGES_ROOT, "connector-core", "src", "git", "solved-staleness.ts"),
    ).text();
    // The vocabulary survives; the computation does not.
    expect(solvedSource).toContain("export type SolvedFileDrift");
    expect(withoutComments(solvedSource)).not.toContain("runGit");
  });
});
