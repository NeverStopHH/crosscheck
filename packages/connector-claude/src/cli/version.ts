import { dirname, join } from "node:path";

/**
 * The version the binary reports, read from the nearest enclosing
 * package.json at call time rather than baked into a constant, so a version
 * bump cannot drift from what `--version` prints.
 *
 * Nearest-FIRST, because the same source file runs from two layouts: in the
 * workspace the walk stops at packages/connector-claude/package.json, and in
 * the published npm package — which ships no per-package manifests — it stops
 * at the package root's. Both carry the same version by release policy.
 */
export const resolveVersion = async (startDir: string): Promise<string> => {
  let dir = startDir;
  for (;;) {
    // A directory without package.json, or with an unparseable one, is not an
    // error here — the walk simply continues to the parent.
    try {
      const raw = await Bun.file(join(dir, "package.json")).text();
      const version = (JSON.parse(raw) as { version?: unknown }).version;
      if (typeof version === "string" && version.length > 0) {
        return version;
      }
    } catch {
      // fall through to the parent directory
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return "unknown";
    }
    dir = parent;
  }
};
