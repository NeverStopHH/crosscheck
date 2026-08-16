/**
 * Assembles the ONE publishable npm package — `crosscheck`, unscoped — into
 * dist/npm/ and runs `npm pack` there. Prints the absolute tarball path as
 * the LAST stdout line; the e2e test and the publish runbook both rely on it.
 *
 * WHY ONE PACKAGE. The @crosscheck npm scope's availability is unknowable
 * read-only (a user or org of that name blocks it), so nothing here may
 * depend on it. A single unscoped package needs one free name — `crosscheck`
 * (HISTORICAL: registry returned 404 for it on 2026-08-16; re-check before
 * the first publish) — and turns the workspace-only `@crosscheck/*`
 * specifiers into a solved problem: they are rewritten at pack time to
 * `crosscheck/...` subpaths of the package itself, which plain node_modules
 * resolution finds because the package IS installed under that name. No
 * build, no bundler: Bun runs the shipped TypeScript sources directly.
 *
 * WHAT SHIPS. Per package: src/ (the .sql runtime asset included), LICENSE,
 * NOTICE — the FSL/Apache split stays legible per shipped directory, with the
 * root LICENSE (the map) beside them. No tests, no docs, no per-package
 * manifests, no lockfile. The whitelist is enforced from the OTHER side by
 * the e2e's mustShip/mustNotShip audit against the installed tree.
 */
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const STAGING = join(REPO_ROOT, "dist", "npm");
const WORKSPACE_PACKAGES = ["schema", "server", "connector-claude"] as const;

interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
}

const readManifest = async (dir: string): Promise<Manifest> =>
  JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as Manifest;

/** One version for everything `--version` can report, or refuse to pack. */
const resolvePublishVersion = (manifests: readonly Manifest[]): string => {
  const versions = new Set(manifests.map((manifest) => manifest.version));
  if (versions.size !== 1) {
    throw new Error(
      `workspace package versions diverge (${[...versions].join(", ")}) — ` +
        "bump them together before packing",
    );
  }
  const [version] = versions;
  return version as string;
};

/**
 * Union of the three packages' RUNTIME deps, minus the internal ones the
 * rewrite absorbs. A range conflict is a packing error, not a coin toss.
 */
const mergeDependencies = (
  manifests: readonly Manifest[],
): Record<string, string> => {
  const merged: Record<string, string> = {};
  for (const manifest of manifests) {
    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
      if (name.startsWith("@crosscheck/")) {
        continue;
      }
      if (merged[name] !== undefined && merged[name] !== range) {
        throw new Error(
          `dependency range conflict for ${name}: "${merged[name]}" vs "${range}"`,
        );
      }
      merged[name] = range;
    }
  }
  return Object.fromEntries(
    Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)),
  );
};

/**
 * `"@crosscheck/schema"` → `"crosscheck/schema"` (and server alike), single
 * and double quotes, static and dynamic imports — a flat string replacement
 * is exact here because the workspace only ever uses bare specifiers, and
 * `assertNoSubpathSpecifiers` REFUSES to pack the day that stops being true.
 */
const rewriteSpecifiers = (source: string): string =>
  source
    .split('"@crosscheck/')
    .join('"crosscheck/')
    .split("'@crosscheck/")
    .join("'crosscheck/");

const isRewritableSource = (name: string): boolean => /\.(ts|tsx)$/.test(name);

/**
 * A subpath import (`@crosscheck/schema/foo`) would survive the flat rewrite
 * as `crosscheck/schema/foo`, which the exports map does not expose — a
 * failure only a USER's runtime would report. Refuse at pack time instead.
 */
const SUBPATH_SPECIFIER_PATTERN = /["']@crosscheck\/[a-z-]+\//;

const assertNoSubpathSpecifiers = async (dir: string): Promise<void> => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await assertNoSubpathSpecifiers(path);
      continue;
    }
    if (!isRewritableSource(entry.name)) {
      continue;
    }
    if (SUBPATH_SPECIFIER_PATTERN.test(await readFile(path, "utf8"))) {
      throw new Error(
        `${path} imports an @crosscheck subpath, which the published ` +
          "exports map does not expose — export it from the package index " +
          "or extend the exports map in pack-npm.ts",
      );
    }
  }
};

const rewriteStagedSources = async (dir: string): Promise<void> => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await rewriteStagedSources(path);
      continue;
    }
    if (!isRewritableSource(entry.name)) {
      continue;
    }
    const source = await readFile(path, "utf8");
    const rewritten = rewriteSpecifiers(source);
    if (rewritten !== source) {
      await writeFile(path, rewritten, "utf8");
    }
  }
};

/** Any surviving `@crosscheck/` specifier would fail only at a user's runtime. */
const assertNoLeftoverSpecifiers = async (dir: string): Promise<void> => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await assertNoLeftoverSpecifiers(path);
      continue;
    }
    if (!isRewritableSource(entry.name)) {
      continue;
    }
    const source = await readFile(path, "utf8");
    if (source.includes('"@crosscheck/') || source.includes("'@crosscheck/")) {
      throw new Error(`unrewritten @crosscheck specifier left in ${path}`);
    }
  }
};

const copyIfExists = async (from: string, to: string): Promise<void> => {
  try {
    await cp(from, to, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
};

const buildManifest = (
  version: string,
  dependencies: Record<string, string>,
): Record<string, unknown> => ({
  name: "crosscheck",
  version,
  description:
    "Team coordination for local coding agents: a self-hosted hub with " +
    "embedded PGlite plus the Claude Code connector — presence, claims, " +
    "diagnosis trees.",
  keywords: [
    "claude-code",
    "coding-agents",
    "team-coordination",
    "mcp",
    "hooks",
    "pglite",
    "developer-tools",
  ],
  // Not one SPDX id, deliberately: schema+connector are Apache-2.0, the
  // server directory is FSL-1.1-ALv2, and the shipped LICENSE file is the map.
  license: "SEE LICENSE IN LICENSE",
  homepage: "https://github.com/NeverStopHH/crosscheck#readme",
  repository: {
    type: "git",
    url: "git+https://github.com/NeverStopHH/crosscheck.git",
  },
  bugs: { url: "https://github.com/NeverStopHH/crosscheck/issues" },
  type: "module",
  bin: { crosscheck: "./bin/crosscheck.cjs" },
  // The bin shim runs under any Node >= 18; everything real needs Bun. npm
  // only warns on engines, so the shim re-checks at runtime and says how to
  // install Bun instead of stack-tracing.
  engines: { node: ">=18", bun: ">=1.3.0" },
  exports: {
    ".": "./packages/connector-claude/src/index.ts",
    "./schema": "./packages/schema/src/index.ts",
    "./server": "./packages/server/src/index.ts",
  },
  dependencies,
  files: ["bin", "packages"],
  publishConfig: { access: "public" },
});

const main = async (): Promise<void> => {
  const manifests = await Promise.all(
    WORKSPACE_PACKAGES.map((name) =>
      readManifest(join(REPO_ROOT, "packages", name)),
    ),
  );
  const version = resolvePublishVersion(manifests);
  const dependencies = mergeDependencies(manifests);

  await rm(STAGING, { recursive: true, force: true });
  await mkdir(join(STAGING, "bin"), { recursive: true });

  for (const name of WORKSPACE_PACKAGES) {
    const from = join(REPO_ROOT, "packages", name);
    const to = join(STAGING, "packages", name);
    await cp(join(from, "src"), join(to, "src"), { recursive: true });
    await cp(join(from, "LICENSE"), join(to, "LICENSE"));
    await copyIfExists(join(from, "NOTICE"), join(to, "NOTICE"));
  }
  await cp(join(REPO_ROOT, "LICENSE"), join(STAGING, "LICENSE"));
  await cp(
    join(REPO_ROOT, "packaging", "npm-README.md"),
    join(STAGING, "README.md"),
  );
  await cp(
    join(REPO_ROOT, "packaging", "bin", "crosscheck.cjs"),
    join(STAGING, "bin", "crosscheck.cjs"),
  );

  await assertNoSubpathSpecifiers(join(STAGING, "packages"));
  await rewriteStagedSources(join(STAGING, "packages"));
  await assertNoLeftoverSpecifiers(join(STAGING, "packages"));

  await writeFile(
    join(STAGING, "package.json"),
    `${JSON.stringify(buildManifest(version, dependencies), null, 2)}\n`,
    "utf8",
  );

  const pack = Bun.spawn({
    cmd: ["npm", "pack", "--pack-destination", STAGING],
    cwd: STAGING,
    stdout: "pipe",
    stderr: "inherit",
  });
  const stdout = await new Response(pack.stdout).text();
  if ((await pack.exited) !== 0) {
    throw new Error("npm pack failed");
  }
  const tarballName = stdout.trim().split("\n").at(-1);
  if (tarballName === undefined || !tarballName.endsWith(".tgz")) {
    throw new Error(`npm pack printed no tarball name: ${stdout}`);
  }
  // The contract: absolute tarball path, last line of stdout.
  console.log(join(STAGING, tarballName));
};

await main();
