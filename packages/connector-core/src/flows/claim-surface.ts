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
import { MAX_CLAIM_SURFACE_PATHS } from "../constants.ts";

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
}

export const resolveDeclaredSurface = async (
  input: DeclaredSurfaceInput,
): Promise<DeclaredSurface> => {
  const patterns = resolveDenylist(input.denylist ?? undefined);
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const path of input.paths) {
    if (kept.length >= MAX_CLAIM_SURFACE_PATHS) {
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
    kept.push(relativePath);
  }
  return { paths: kept, dropped: input.paths.length - kept.length };
};
