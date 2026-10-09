/**
 * THE PACKAGE SHIPS WHAT A RUNTIME ENTRY REACHES, AND NOTHING A RUNTIME LOADS
 * IS LEFT OUT (cli/scripts/pack-reach.ts).
 *
 * The bundler sees imports; it cannot see a file loaded by path or through a
 * computed `import()`. So these pin the two ways the computed set could drop
 * something a runtime needs:
 * - every file a shipped source loads by a literal path ships;
 * - no shipped source imports through a specifier the bundler cannot follow.
 * They also pin what stays out, so the trim cannot quietly undo itself.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import {
  PATH_LOADED_ASSETS,
  reachedSources,
  runtimeEntries,
  shipsSource,
  withTypeImports,
} from "../scripts/pack-reach.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
/** The non-wildcard export targets pack-npm.ts promises (its buildManifest). */
const EXPORT_TARGETS = [
  "packages/cli/src/index.ts",
  "packages/schema/src/index.ts",
  "packages/server/src/index.ts",
  "packages/connector-core/src/index.ts",
  "packages/connector-acp/src/index.ts",
  "packages/connector-claude/src/index.ts",
  "packages/connector-cursor/src/index.ts",
];

/** Under `src/`, imported only by tests, CI scripts or an ops script. */
const TEST_ONLY_SOURCES = [
  "packages/cli/src/render-surfaces.ts",
  "packages/cli/src/render-surfaces-outcomes.ts",
  "packages/connector-acp/src/render-surfaces.ts",
  "packages/connector-claude/src/render-surfaces.ts",
  "packages/connector-core/src/render-surfaces.ts",
  "packages/connector-cursor/src/render-surfaces.ts",
  "packages/connector-core/src/guarantees/check.ts",
  "packages/server/src/services/calibration.ts",
  "packages/server/src/services/landed-repair.ts",
];

let reached: ReadonlySet<string> = new Set();
let shipped: readonly string[] = [];

beforeAll(async () => {
  reached = await withTypeImports(REPO_ROOT, await reachedSources(REPO_ROOT, [...runtimeEntries(REPO_ROOT), ...EXPORT_TARGETS]));
  shipped = Array.from(new Bun.Glob("packages/*/src/**/*").scanSync({ cwd: REPO_ROOT, dot: true }))
    .filter((file) => shipsSource(reached, file))
    .sort();
});

const shippedSources = (): readonly string[] => shipped.filter((file) => /\.tsx?$/.test(file));

/** The literal path arguments of `new URL("<p>", import.meta.url)` and `resolve(import.meta.dir, "<p>", …)`. */
const literalPathLoads = (file: string, source: string): readonly string[] => {
  const loads: string[] = [];
  for (const match of source.matchAll(/new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g)) {
    loads.push(join(dirname(file), match[1] ?? ""));
  }
  for (const match of source.matchAll(/resolve\(\s*import\.meta\.dir\s*,((?:\s*["'][^"']*["']\s*,?)+)\s*\)/g)) {
    const segments = Array.from((match[1] ?? "").matchAll(/["']([^"']*)["']/g), (segment) => segment[1] ?? "");
    loads.push(join(dirname(file), ...segments));
  }
  return loads.map((path) => relative(REPO_ROOT, resolve(REPO_ROOT, path)));
};

describe("the shipped set", () => {
  test("starts from the CLI and the ten worker entries, and the bundler reports all of them", () => {
    // Act
    const entries = runtimeEntries(REPO_ROOT);

    // Assert
    expect(entries).toHaveLength(11);
    expect(entries[0]).toBe("packages/cli/src/bin/crosscheck.ts");
    expect(entries.every((entry) => reached.has(entry))).toBe(true);
  });

  test("ships every file a shipped source loads by a literal path", async () => {
    // Arrange — the loads the bundler cannot see
    const loads: { readonly from: string; readonly target: string }[] = [];
    for (const file of shippedSources()) {
      for (const target of literalPathLoads(file, await Bun.file(join(REPO_ROOT, file)).text())) {
        loads.push({ from: file, target });
      }
    }
    const intoSources = loads.filter(
      ({ target }) => /^packages\/[^/]+\/src\//.test(target) && existsSync(join(REPO_ROOT, target)) && statSync(join(REPO_ROOT, target)).isFile(),
    );

    // Act
    const leftOut = intoSources.filter(({ target }) => !shipsSource(reached, target));

    // Assert — the walk is real (it finds the worker, the bunfig, the sql and the worker entries)
    expect(intoSources.map(({ target }) => target)).toEqual(
      expect.arrayContaining([...PATH_LOADED_ASSETS, "packages/connector-claude/src/landing-fetch/worker-entry.ts"]),
    );
    expect(leftOut).toEqual([]);
  });

  test("ships no source that imports through a specifier the bundler cannot follow", async () => {
    // Arrange
    const computed: string[] = [];

    // Act — `import(` whose argument does not open with a string quote
    for (const file of shippedSources()) {
      const source = await Bun.file(join(REPO_ROOT, file)).text();
      for (const match of source.matchAll(/\bimport\(\s*(.)/g)) {
        if (match[1] !== '"' && match[1] !== "'") {
          computed.push(`${file}: import(${match[1] ?? ""}`);
        }
      }
    }

    // Assert
    expect(computed).toEqual([]);
  });

  test("keeps the path-loaded assets and the type-only modules, and leaves the test-only modules out", () => {
    // Act + Assert
    expect(PATH_LOADED_ASSETS.every((asset) => existsSync(join(REPO_ROOT, asset)))).toBe(true);
    expect(PATH_LOADED_ASSETS.filter((asset) => !shipped.includes(asset))).toEqual([]);
    expect(shipped).toContain("packages/server/src/types.ts");
    expect(shipped).toContain("packages/connector-core/src/git/solved-staleness.ts");
    expect(TEST_ONLY_SOURCES.every((file) => existsSync(join(REPO_ROOT, file)))).toBe(true);
    expect(TEST_ONLY_SOURCES.filter((file) => shipped.includes(file))).toEqual([]);
  });
});
