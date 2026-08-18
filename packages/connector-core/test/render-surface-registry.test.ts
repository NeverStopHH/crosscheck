/**
 * §4.4's two enforcement halves, in one file:
 *
 * 1. THE CORPUS ON EVERY REGISTERED SURFACE. Each `corpus` registration
 *    renders every injection payload and is held to its framing class:
 *    framed output carries QUOTED_DATA_NOTICE, every line passes the
 *    character invariants (fixtures/untrusted-invariants.ts — the SAME
 *    assertions the briefing and MCP corpora use), and at most one « » pair
 *    per line; `sanitized` output additionally carries no frame characters
 *    at all.
 *
 * 2. THE META-TEST. Every src module of every connector package is walked
 *    for calls into the render layer — an import whose specifier is a
 *    render-layer module, or whose imported names include a render-layer
 *    identifier. Every such module must be the render layer itself, a
 *    re-export barrel, or REGISTERED in its package's RENDER_SURFACES.
 *    A new render file that skips registration is a red build — which is
 *    what §1.4's "non-negotiable" means mechanically. (Proven to bite
 *    during Block 2: a scratch src/scratch-render.ts importing
 *    sanitizeUntrusted turned exactly this test red before it was removed.)
 *
 * Type-only imports are exempt: a type cannot render.
 */
import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import { QUOTED_DATA_NOTICE } from "../src/briefing/render.ts";
import {
  RENDER_BARREL_MODULES,
  RENDER_LAYER_MODULES,
  RENDER_SURFACES,
} from "../src/render-surfaces.ts";
import type {
  CorpusRenderSurface,
  RenderSurface,
} from "../src/render-surfaces.ts";
import { RENDER_SURFACES as CLAUDE_RENDER_SURFACES } from "../../connector-claude/src/render-surfaces.ts";
import { INJECTION_CORPUS } from "./fixtures/injection-corpus.ts";
import { assertUntrustedCharacters } from "./fixtures/untrusted-invariants.ts";

const CORE_ROOT = join(import.meta.dir, "..");
const CLAUDE_ROOT = join(import.meta.dir, "..", "..", "connector-claude");

/**
 * Import specifiers that ARE the render layer, however they are reached —
 * relative (`../briefing/sanitize.ts`) or cross-package
 * (`@crosscheck/connector-core/briefing/sanitize.ts`).
 */
const RENDER_LAYER_SPECIFIER =
  /(briefing\/(?:sanitize|render)|hints\/render|mcp\/render(?:-referee)?)\.ts$/;

/**
 * The render layer's value exports. An import of any of these names flags
 * the importer even when it dodges the specifier match by importing through
 * a barrel. Names, not paths, are what a barrel import carries.
 */
const RENDER_IDENTIFIERS: ReadonlySet<string> = new Set([
  "sanitizeUntrusted",
  "bareUntrusted",
  "safeId",
  "quoted",
  "quotingText",
  "renderBriefing",
  "renderClaimHint",
  "renderPointerHint",
  "renderTripwireReason",
  "renderDiagnosis",
  "renderSearchResults",
  "renderUnusableQuery",
  "renderRefereeBrief",
  "QUOTED_DATA_NOTICE",
  "formatSolvedLine",
  "formatAbsenceLine",
  "formatContradictionLine",
  "formatDraftLine",
  "groupTeammates",
  "formatAge",
  "formatSolvedAge",
]);

/** import/export-from statements: clause + specifier. */
const IMPORT_PATTERN =
  /(?:import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g;

const importedNames = (clause: string): readonly string[] => {
  const braced = /\{([\s\S]*?)\}/.exec(clause);
  if (braced?.[1] === undefined) {
    return [];
  }
  return braced[1]
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !entry.startsWith("type "))
    .map((entry) => entry.split(/\s+as\s+/)[0] ?? entry)
    .map((entry) => entry.trim());
};

/** True when the module imports render-layer VALUES (type-only is exempt). */
const touchesRenderLayer = (source: string): boolean => {
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const [, typeOnly, clause, specifier] = match;
    if (typeOnly !== undefined || clause === undefined || specifier === undefined) {
      continue;
    }
    const names = importedNames(clause);
    if (RENDER_LAYER_SPECIFIER.test(specifier)) {
      // A value import from a render-layer module; names may be empty for
      // namespace imports (`* as`), which flag too.
      return true;
    }
    if (names.some((name) => RENDER_IDENTIFIERS.has(name))) {
      return true;
    }
  }
  return false;
};

const listSourceFiles = async (root: string): Promise<readonly string[]> => {
  const entries = await readdir(join(root, "src"), {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) =>
      join("src", relative(join(root, "src"), join(entry.parentPath, entry.name))),
    )
    .sort();
};

interface PackageRegistration {
  readonly label: string;
  readonly root: string;
  readonly surfaces: readonly RenderSurface[];
  /** Modules exempt beyond registrations: the layer itself + barrels. */
  readonly exempt: readonly string[];
}

const PACKAGES: readonly PackageRegistration[] = [
  {
    label: "connector-core",
    root: CORE_ROOT,
    surfaces: RENDER_SURFACES,
    exempt: [...RENDER_LAYER_MODULES, ...RENDER_BARREL_MODULES],
  },
  {
    label: "connector-claude",
    root: CLAUDE_ROOT,
    surfaces: CLAUDE_RENDER_SURFACES,
    // Its registry file names render identifiers in comments/adapters and is
    // the registration itself — the one structural exemption it gets.
    exempt: ["src/render-surfaces.ts"],
  },
];

const ALL_SURFACES: readonly RenderSurface[] = [
  ...RENDER_SURFACES,
  ...CLAUDE_RENDER_SURFACES,
];

const CORPUS_SURFACES: readonly CorpusRenderSurface[] = ALL_SURFACES.filter(
  (surface): surface is CorpusRenderSurface => surface.kind === "corpus",
);

describe("§4.4: the corpus runs on every registered surface", () => {
  test("there are corpus surfaces to run — the registry cannot be hollowed out", () => {
    // Core's eight + Claude's title path. Shrinking this list is a design
    // decision, not a refactor side effect; the floor makes that loud.
    expect(CORPUS_SURFACES.length).toBeGreaterThanOrEqual(9);
  });

  test.each(CORPUS_SURFACES.map((surface) => [surface.name, surface] as const))(
    "%s renders substance for a benign payload — adapters cannot rot silently",
    (_name, surface) => {
      // Arrange: ordinary teammate text, nothing for the sanitizer to strip.
      const output = surface.render("rate limit fix");

      // Assert
      expect(output.length, surface.name).toBeGreaterThan(0);
      if (surface.framing === "framed") {
        expect(output, surface.name).toContain(QUOTED_DATA_NOTICE);
      }
    },
  );

  test.each(CORPUS_SURFACES.map((surface) => [surface.name, surface] as const))(
    "%s holds its framing class against every payload",
    (_name, surface) => {
      for (const { id, payload } of INJECTION_CORPUS) {
        // Act
        const output = surface.render(payload);
        const where = `${surface.name}/${id}`;

        // Assert: the class-wide character invariants on every line.
        for (const line of output.split("\n")) {
          assertUntrustedCharacters(line, where);
        }
        if (surface.framing === "framed") {
          // A framed document names its frame — unless the render collapsed
          // to EMPTY because every untrusted slot sanitized away (a lone «
          // leaves no name, no branch, no title: nothing to show is a
          // correct render). Non-emptiness is pinned on a benign payload in
          // the test below, where it cannot be excused.
          if (output.length > 0) {
            expect(output, where).toContain(QUOTED_DATA_NOTICE);
          }
        } else {
          // sanitized / bare / id: no frame characters at all — the frame
          // belongs to whichever framed surface shows this value later.
          expect(output.includes("«"), where).toBe(false);
          expect(output.includes("»"), where).toBe(false);
        }
      }
    },
  );
});

describe("§4.4: unregistered render surfaces are a red build", () => {
  test.each(PACKAGES.map((pkg) => [pkg.label, pkg] as const))(
    "every %s module that touches the render layer is registered",
    async (_label, pkg) => {
      // Arrange
      const files = await listSourceFiles(pkg.root);
      const allowed = new Set([
        ...pkg.exempt,
        ...pkg.surfaces.map((surface) => surface.module),
      ]);

      // Act
      const flagged: string[] = [];
      for (const file of files) {
        const source = await Bun.file(join(pkg.root, file)).text();
        if (touchesRenderLayer(source) && !allowed.has(file)) {
          flagged.push(file);
        }
      }

      // Assert: name the offender and say what to do about it.
      expect(
        flagged,
        `unregistered render surface(s) in ${pkg.label}: ${flagged.join(", ")} — ` +
          "register in src/render-surfaces.ts (RENDER_SURFACES) or render through a registered surface",
      ).toEqual([]);
    },
  );

  test("every registered module exists — registrations cannot go stale", async () => {
    for (const pkg of PACKAGES) {
      for (const surface of pkg.surfaces) {
        expect(
          await Bun.file(join(pkg.root, surface.module)).exists(),
          `${pkg.label}: ${surface.name} names a missing module ${surface.module}`,
        ).toBe(true);
      }
    }
  });

  test("every registered module really touches the render layer — no decorative rows", async () => {
    // The inverse guard: a registration whose module no longer renders keeps
    // the table honest by being removed, not by rotting in place.
    for (const pkg of PACKAGES) {
      for (const surface of pkg.surfaces) {
        const source = await Bun.file(join(pkg.root, surface.module)).text();
        expect(
          touchesRenderLayer(source),
          `${pkg.label}: ${surface.name} (${surface.module}) imports nothing from the render layer`,
        ).toBe(true);
      }
    }
  });

  test("surface names are unique across packages", () => {
    const names = ALL_SURFACES.map((surface) => surface.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
