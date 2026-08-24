/**
 * Does this repo's .gitignore swallow the file we are telling people to
 * commit? (trial finding M11)
 *
 * `init` prints "commit .mcp.json so teammates get the mcp tools on git pull",
 * `doctor` says "teammates get the tools from a committed …/.mcp.json", and
 * the double-wiring WARN recommends `crosscheck init --global --remove`. All
 * three assume the project files reach a teammate. In the monorepo the trial
 * ran in they do not: `git check-ignore -v` puts `.mcp.json` at `.gitignore:5`
 * and `.claude/*` at `:13`. The worst of the three is the remedy — removing
 * the global install there leaves the developer with a project install nobody
 * else can ever receive, which is the state incidents #9 and #11 were about.
 *
 * THREE-VALUED, and the third value is the point. `null` means git could not
 * answer — not installed, not a repo, a timeout — and every caller renders
 * exactly what it rendered before this module existed. Advice that is
 * confidently wrong is worse than advice that is merely old.
 */
import { GIT_TIMEOUT_MS } from "../constants.ts";
import { runBoundedCommand } from "./git.ts";

/**
 * `true` = ignored, `false` = not ignored, `null` = git could not say.
 *
 * TWO commands rather than one, because `runBoundedCommand` folds a non-zero
 * exit and an empty stdout into the same `null` — and `git check-ignore -q`
 * says everything through its exit code and prints nothing at all, so through
 * that helper "ignored" and "git is missing" would be indistinguishable.
 * Without `-q` an IGNORED path is echoed on stdout (a non-null answer), and a
 * path that is merely not ignored prints nothing — which is where the second
 * command comes in: it asks whether git works here at all, and only its
 * silence yields `null`. The second spawn happens only in the not-ignored
 * case, on human-run surfaces (`doctor`, `init`), never on a hook path.
 *
 * A TRACKED file is never reported ignored by git, which is the behaviour
 * wanted: a committed `.mcp.json` reaches teammates whatever the ignore file
 * says about its name.
 */
export const isPathIgnored = async (
  repoRoot: string,
  relativePath: string,
): Promise<boolean | null> => {
  const ignored = await runBoundedCommand(
    ["git", "check-ignore", relativePath],
    repoRoot,
    GIT_TIMEOUT_MS,
  );
  if (ignored !== null) {
    return true;
  }
  const inWorkTree = await runBoundedCommand(
    ["git", "rev-parse", "--is-inside-work-tree"],
    repoRoot,
    GIT_TIMEOUT_MS,
  );
  return inWorkTree === "true" ? false : null;
};
