/**
 * Every workspace package's RENDER_SURFACES, discovered off the filesystem.
 *
 * DISCOVERED, NOT ENUMERATED, for the reason §4.4 gives: a connector added
 * tomorrow is enforced the day its directory appears, and a list of package
 * names in a test file is a second registry that drifts from the first.
 *
 * IT LIVES HERE RATHER THAN IN ONE TEST because two files now walk it —
 * render-surface-registry.test.ts (does every rendering module register?) and
 * anchoring-separation.test.ts (does every unsolicited surface stay tight?).
 * Two copies of the walk would be two things to keep in step, and the second
 * copy is exactly where a package would go quietly unwalked.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type { RenderSurface } from "../../src/render-surfaces.ts";

export interface RegisteredPackage {
  readonly label: string;
  readonly root: string;
  readonly surfaces: readonly RenderSurface[];
}

const WORKSPACE_PACKAGES_ROOT = join(import.meta.dir, "..", "..", "..");

const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

/** Every packages/* directory with a src tree, in name order. */
const discoverPackages = async (): Promise<readonly RegisteredPackage[]> => {
  const entries = await readdir(WORKSPACE_PACKAGES_ROOT, {
    withFileTypes: true,
  });
  const labels = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const packages: RegisteredPackage[] = [];
  for (const label of labels) {
    const root = join(WORKSPACE_PACKAGES_ROOT, label);
    if (!(await isDirectory(join(root, "src")))) {
      continue;
    }
    const registryPath = join(root, "src", "render-surfaces.ts");
    const surfaces = (await Bun.file(registryPath).exists())
      ? ((
          (await import(registryPath)) as {
            RENDER_SURFACES?: readonly RenderSurface[];
          }
        ).RENDER_SURFACES ?? [])
      : [];
    packages.push({ label, root, surfaces });
  }
  return packages;
};

export const REGISTERED_PACKAGES: readonly RegisteredPackage[] =
  await discoverPackages();

export const ALL_REGISTERED_SURFACES: readonly RenderSurface[] =
  REGISTERED_PACKAGES.flatMap((pkg) => pkg.surfaces);
