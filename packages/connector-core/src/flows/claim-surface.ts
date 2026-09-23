/**
 * THE DECLARED HALF OF A CLAIM'S AFFECTED SURFACE (1.0 spec 02 §3.2).
 *
 * An author who says which files a finding is about gets a revalidation scoped
 * to THOSE files. Without it the fallback is the whole work context's `file`
 * targets, which over-fires by construction: any file the session touched
 * moving marks every claim on that tree.
 *
 * NOTHING IS INFERRED FROM AGENT PROSE. The paths come from an explicit tool
 * argument or they do not exist — heavy intent inference from chatter is cut
 * from 1.0, and guessing a surface out of a sentence is the same mistake with
 * a different noun.
 *
 * Every path travels the pipeline a captured target already does:
 * `toRepoRelative` → `isDenied` → `containsSecret`. A path that fails any of
 * them is DROPPED, never redacted and never stored.
 */
import { containsSecret } from "../capture/secret-scan.ts";
import { isDenied, resolveDenylist } from "../capture/denylist.ts";
import type { DenylistConfig } from "../capture/denylist.ts";
import { toRepoRelative } from "../capture/target-paths.ts";
import {
  MAX_CLAIM_SURFACE_CANDIDATES,
  MAX_CLAIM_SURFACE_PATHS,
} from "../constants.ts";

export interface DeclaredSurfaceInput {
  readonly repoRoot: string;
  readonly cwd: string;
  readonly paths: readonly string[];
  readonly denylist?: DenylistConfig | undefined;
}

export interface DeclaredSurface {
  /** Repo-relative POSIX paths, deduplicated, capped, in the author's order. */
  readonly paths: readonly string[];
  /** How many the author offered that did not survive — never silent. */
  readonly dropped: number;
  /**
   * How many were never looked at because the list ran past its budget.
   *
   * A SUBSET OF `dropped`, carried separately because the reason differs and
   * the note has to say which. A path dropped by policy was measured and
   * refused; a path past the budget was never read, and telling an author it
   * was "outside the repo, denied, or unreadable" would be a reason invented
   * after the fact for a file nobody opened.
   */
  readonly unexamined: number;
}

export const resolveDeclaredSurface = async (
  input: DeclaredSurfaceInput,
): Promise<DeclaredSurface> => {
  const patterns = resolveDenylist(input.denylist ?? undefined);
  const kept: string[] = [];
  const seen = new Set<string>();
  let examined = 0;
  for (const path of input.paths) {
    if (kept.length >= MAX_CLAIM_SURFACE_PATHS) {
      break;
    }
    // THE KEEP CAP ABOVE DOES NOT BOUND THIS LOOP, and that is the whole
    // reason this one exists. It fires on paths KEPT, so a list none of whose
    // entries survive never reaches it: 50 000 paths outside the repo were
    // walked to the end, spending 2 959 ms of the calling agent's own MCP
    // turn to keep nothing and say nothing. Budgeted, the same list costs
    // one `MAX_CLAIM_SURFACE_CANDIDATES`-long walk.
    if (examined >= MAX_CLAIM_SURFACE_CANDIDATES) {
      break;
    }
    examined += 1;
    const relativePath = await toRepoRelative(input.repoRoot, input.cwd, path);
    if (relativePath === null || isDenied(relativePath, patterns)) {
      continue;
    }
    if (containsSecret(relativePath) || seen.has(relativePath)) {
      continue;
    }
    seen.add(relativePath);
    kept.push(relativePath);
  }
  return {
    paths: kept,
    dropped: input.paths.length - kept.length,
    // EVERY ENTRY THE LOOP NEVER REACHED, whichever break stopped it. When the
    // keep cap stopped it the author got a full surface and the rest are
    // simply surplus; when the budget stopped it they did not, and the note
    // below is the only place that difference is visible.
    unexamined:
      kept.length >= MAX_CLAIM_SURFACE_PATHS
        ? 0
        : Math.max(0, input.paths.length - examined),
  };
};

/**
 * What the author is told when their declared surface came back narrower.
 *
 * `dropped` has carried the comment "never silent" since it was written and
 * had NO READER anywhere: all three tools took `surface.paths` and discarded
 * the count, so an author who declared four paths and got three back was told
 * nothing at all.
 *
 * THE DIRECTION IS WHY IT MATTERS. A narrowed surface makes `unchanged` more
 * likely, and the currency clause then asserts that the files have not moved
 * — about a set the author never agreed to. It is the same shape as the cap
 * that vouched for paths nobody looked at, one step earlier: there, the
 * measurement was narrowed; here, the declaration is.
 *
 * A NOTE, NEVER A REFUSAL. The claim is legal and worth storing; what is not
 * acceptable is storing it while the author believes it covers more.
 *
 * THE UNEXAMINED TAIL GETS ITS OWN SENTENCE. Naming a reason that was never
 * measured is the shape principle 3 forbids one step down: the three reasons
 * this note lists are verdicts the resolver reached, and a path past the
 * budget has no verdict at all. An author whose list was cut can resend the
 * part that mattered; an author told their paths were "denied by policy"
 * would go looking for a policy.
 */
export const droppedSurfaceNote = (surface: DeclaredSurface): string | null => {
  if (surface.dropped === 0) {
    return null;
  }
  const measured = surface.dropped - surface.unexamined;
  const head =
    `${String(surface.dropped)} of the ${String(surface.dropped + surface.paths.length)} paths you declared ` +
    "were not stored, so this claim's surface is the rest. A revalidation " +
    "measures only what is stored.";
  const why =
    measured > 0
      ? ` ${String(measured)} were dropped on inspection (outside the repo, denied by policy, or unreadable).`
      : "";
  const cut =
    surface.unexamined > 0
      ? ` ${String(surface.unexamined)} were never inspected: the list ran past the ` +
        `${String(MAX_CLAIM_SURFACE_CANDIDATES)} declarations one claim is read for. ` +
        "Declare the paths the finding is about and they will all be read."
      : "";
  return `${head}${why}${cut}`;
};
