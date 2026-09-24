/**
 * Repo-relative target paths — a CROSS-CONNECTOR identity function.
 *
 * The POSIX repo-relative path this derives IS the target id that cross-agent
 * matching joins on, so every connector must derive it identically: a Claude
 * hook, an ACP proxy and a Cursor hook seeing the same file must mint the
 * same id, or target matching silently splits per agent — the same one-copy
 * argument that keeps `fingerprint()` in core (DESIGN-agent-agnostic.md
 * §1.2). Moved here from connector-claude's post-tool-use.ts verbatim;
 * test/target-paths.test.ts pins the shipped behavior, including the
 * realpath fallback that makes a symlinked worktree (macOS /tmp, /var)
 * derive the same id under either spelling.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";

import { canonicalRepoPath } from "@crosscheck/schema";

import { realpathBestEffort } from "../config/paths.ts";

/**
 * POSIX separators on the wire — a Windows target must match a macOS one —
 * and the ONE spelling the hub and the pin door share (01a §3.3d): NFC, so a
 * decomposed name a macOS filesystem handed back meets the composed name git
 * stores. A path that cannot be made canonical is sent as it is: the hub keeps
 * it, and a touch is evidence nobody should drop here.
 */
const toPosix = (path: string): string => {
  const posix = path.split(sep).join("/");
  const canonical = canonicalRepoPath(posix);
  return canonical.ok ? canonical.path : posix;
};

/**
 * The file's path relative to the repo root, POSIX-separated — or null when
 * the file is outside the repo (or is the root itself): not a target.
 */
export const toRepoRelative = async (
  repoRoot: string,
  cwd: string,
  filePath: string,
): Promise<string | null> => {
  const absolute = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
  const direct = relative(repoRoot, absolute);
  if (direct.length > 0 && !direct.startsWith("..") && !isAbsolute(direct)) {
    return toPosix(direct);
  }
  const resolvedRoot = await realpathBestEffort(repoRoot);
  const resolvedFile = await realpathBestEffort(absolute);
  const viaRealpath = relative(resolvedRoot, resolvedFile);
  if (
    viaRealpath.length === 0 ||
    viaRealpath.startsWith("..") ||
    isAbsolute(viaRealpath)
  ) {
    return null;
  }
  return toPosix(viaRealpath);
};
