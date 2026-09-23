import { z } from "zod";

/** A repo-relative path is never long; the cap keeps one row renderable. */
export const MAX_REPO_PATH_CHARS = 300;

/**
 * THE ONE PATH SHAPE a hand-declared file may have, wherever it is declared.
 *
 * `toRepoRelative` (connector-core capture/target-paths.ts) is the only minter
 * of a target value, and it emits POSIX-separated, repo-relative paths with no
 * leading slash and no `..`. A pin — or a claim's affected surface — carrying
 * anything else could never intersect a touch or resolve on a ref, so it would
 * watch NOTHING while reading as registered. That is the fail-silent-dead
 * shape the design forbids, so it is a parse error instead.
 *
 * ITS OWN MODULE, deliberately: `pin.ts` and `claim.ts` both need it, and
 * claim.ts importing pin.ts closed a cycle (pin → question → claim) that broke
 * module initialisation at runtime rather than at the type checker.
 */
export const REPO_RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\\]+$/;

export const repoRelativePath = z
  .string()
  .min(1)
  .max(MAX_REPO_PATH_CHARS)
  .regex(REPO_RELATIVE_PATH, "path is not repo-relative POSIX");
