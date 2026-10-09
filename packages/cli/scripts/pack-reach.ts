/**
 * ONLY WHAT A RUNTIME ENTRY REACHES SHIPS (pack-npm.ts; the 2 000 000-byte
 * tarball cap, batch 2).
 *
 * Every `src/` file used to ship, so files only tests import — the
 * render-surface registries, guarantee and calibration checkers, an ops
 * repair module — rode along. Here the shipped set is COMPUTED. Bun's bundler
 * follows every static and literal dynamic import from:
 * - the runtime entries: the CLI bin and every `*worker-entry.ts`;
 * - the package's export targets, the library surface it promises (pack-npm.ts
 *   `buildManifest`);
 * and its metafile names every file it reached. A file outside that set
 * ships only if a runtime entry loads it BY PATH, where no bundler can see it:
 * those are `PATH_LOADED_ASSETS`, each with the line that loads it. The
 * pack-reach test fails when a shipped source loads a file by a literal path
 * that would not ship, so a new asset cannot be left off this list quietly.
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** Files a runtime entry loads by path, relative to the repo root. */
export const PATH_LOADED_ASSETS: readonly string[] = [
  // connector-acp/src/fd-io.ts: new Worker(new URL("./fd-reader.worker.ts", import.meta.url))
  "packages/connector-acp/src/fd-reader.worker.ts",
  // connector-core/src/config/runtime-isolation.ts: --config=<this file> on every start
  "packages/connector-core/src/config/isolated.bunfig.toml",
  // server/src/db/client.ts: new URL("./bootstrap.sql", import.meta.url), read at boot
  "packages/server/src/db/bootstrap.sql",
];

/** The processes crosscheck starts by entry file, relative to the repo root. */
export const runtimeEntries = (repoRoot: string): readonly string[] => [
  "packages/cli/src/bin/crosscheck.ts",
  ...Array.from(new Bun.Glob("packages/*/src/**/*worker-entry.ts").scanSync({ cwd: repoRoot })).sort(),
];

/** The argument that makes this file print the reached set instead of being a library. */
const BUNDLE_MODE = "--reached-sources";

/**
 * Source files reached from `entries` (repo-relative), as repo-relative real
 * paths. The bundling runs in a `bun` process of its own: `Bun.build` inside
 * a `bun test` started at the repo root failed to resolve even relative
 * imports (measured, Bun 1.3.13), while a plain process resolves the same
 * graph from any cwd.
 */
export const reachedSources = async (repoRoot: string, entries: readonly string[]): Promise<ReadonlySet<string>> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, import.meta.path, BUNDLE_MODE, repoRoot, ...entries],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`bundling the runtime entries failed:\n${stderr}`);
  }
  return new Set(JSON.parse(stdout) as string[]);
};

/** The bundling itself, in the process `reachedSources` starts. */
const bundleReached = async (repoRoot: string, entries: readonly string[]): Promise<ReadonlySet<string>> => {
  const result = await Bun.build({
    entrypoints: entries.map((entry) => join(repoRoot, entry)),
    root: repoRoot,
    target: "bun",
    metafile: true,
  } as Parameters<typeof Bun.build>[0]);
  const inputs = (result as unknown as { readonly metafile?: { readonly inputs: Record<string, unknown> } }).metafile?.inputs;
  if (!result.success || inputs === undefined) {
    throw new Error(`bundling the runtime entries failed:\n${result.logs.map(String).join("\n")}`);
  }
  // Metafile paths are relative to the process cwd (measured: not to `root`).
  // Workspace packages resolve through node_modules symlinks, so a reached
  // file is compared by its REAL path, never by the name it was reached under.
  const realRoot = realpathSync(repoRoot);
  const reached = new Set<string>();
  for (const input of Object.keys(inputs)) {
    try {
      reached.add(relative(realRoot, realpathSync(resolve(process.cwd(), input))));
    } catch {
      // A virtual module or a vanished path: nothing on disk to ship.
    }
  }
  const missing = entries.filter((entry) => !reached.has(entry));
  if (missing.length > 0) {
    throw new Error(`the bundler did not report its own entries (${missing.join(", ")}): refusing to prune by its metafile`);
  }
  return reached;
};

if (import.meta.main && process.argv[2] === BUNDLE_MODE) {
  const [, , , repoRoot = "", ...entries] = process.argv;
  console.log(JSON.stringify([...(await bundleReached(repoRoot, entries))]));
}

/** `import type … from "x"` and `export type … from "x"`: erased at runtime, so the bundler never follows them. */
const TYPE_ONLY_SPECIFIER = /(?:import|export)\s+type\s[^;]*?\sfrom\s+["']([^"']+)["']/g;
const WORKSPACE_SPECIFIER = /^@crosscheck\/([a-z-]+)(?:\/(.+))?$/;

/** The repo-relative file a type-only specifier in `fromFile` names, or null outside the workspace. */
const typeImportTarget = (fromFile: string, specifier: string): string | null => {
  if (specifier.startsWith(".")) {
    return join(dirname(fromFile), specifier);
  }
  const workspace = WORKSPACE_SPECIFIER.exec(specifier);
  if (workspace === null) {
    return null;
  }
  const [, name = "", subpath] = workspace;
  return subpath === undefined ? `packages/${name}/src/index.ts` : `packages/${name}/src/${subpath}`;
};

/**
 * `reached`, closed over type-only imports. They cost nothing at runtime
 * (tsconfig sets verbatimModuleSyntax, so only `import type` is erased), but
 * the package ships TypeScript sources: a consumer that type-checks
 * `crosscheck-hub/server` must find the `./types.ts` its index re-exports.
 */
export const withTypeImports = async (repoRoot: string, reached: ReadonlySet<string>): Promise<ReadonlySet<string>> => {
  const closed = new Set(reached);
  const queue = [...reached].filter((file) => /\.tsx?$/.test(file));
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    const source = await Bun.file(join(repoRoot, file)).text();
    for (const match of source.matchAll(TYPE_ONLY_SPECIFIER)) {
      const target = typeImportTarget(file, match[1] ?? "");
      if (target !== null && !closed.has(target) && existsSync(join(repoRoot, target))) {
        closed.add(target);
        queue.push(target);
      }
    }
  }
  return closed;
};

/** Whether a repo-relative `src/` file ships: reached from an entry or by a type, or loaded by path. */
export const shipsSource = (reached: ReadonlySet<string>, file: string): boolean =>
  reached.has(file) || PATH_LOADED_ASSETS.includes(file);
