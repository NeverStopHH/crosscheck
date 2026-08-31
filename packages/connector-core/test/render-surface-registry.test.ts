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
 * 2. THE META-TEST. Every src module of EVERY workspace package is walked
 *    for calls into the render layer — an import whose specifier is a
 *    render-layer module (static, dynamic `import()` or `require()`), whose
 *    imported names include a render-layer identifier, or a namespace import
 *    of a local barrel whose members reach one. Every such module must be
 *    the render layer itself, a re-export barrel, or REGISTERED in its
 *    package's RENDER_SURFACES. A new render file that skips registration is
 *    a red build — which is what §1.4's "non-negotiable" means mechanically.
 *    (Proven to bite during Block 2 twice: a scratch src/scratch-render.ts
 *    importing sanitizeUntrusted, and — after the review — a scratch package
 *    packages/connector-acp plus a namespace-through-barrel dodge, both red
 *    before removal.)
 *
 * PACKAGES ARE DISCOVERED, NOT ENUMERATED: the walk reads packages/* off the
 * filesystem, so the connector Blocks 3-7 create is enforced the day its
 * directory appears — registering surfaces means exporting RENDER_SURFACES
 * from its own src/render-surfaces.ts, which this file auto-imports.
 *
 * COMPOSITE REGISTRATIONS ARE VERIFIED, NOT TRUSTED: a composite's claim to
 * corpus coverage lives in `corpusCoveredBy`, and every file named there must
 * exist and actually run the corpus or the shared invariants. The prose
 * `note` may not smuggle the claim ("corpus-covered" is banned from notes),
 * and any test file a note names must exist.
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
} from "../src/render-surfaces.ts";
import type {
  CorpusRenderSurface,
  RenderSurface,
} from "../src/render-surfaces.ts";
import { INJECTION_CORPUS } from "./fixtures/injection-corpus.ts";
import {
  ALL_REGISTERED_SURFACES,
  REGISTERED_PACKAGES,
} from "./fixtures/registry-packages.ts";
import { assertUntrustedCharacters } from "./fixtures/untrusted-invariants.ts";

const WORKSPACE_PACKAGES_ROOT = join(import.meta.dir, "..", "..");

/** This package's root, so a RENDER_LAYER_MODULES path can be imported. */
const CORE_ROOT = join(import.meta.dir, "..");

/**
 * Import specifiers that ARE the render layer, however they are reached —
 * relative (`../briefing/sanitize.ts`) or cross-package
 * (`@crosscheck/connector-core/briefing/sanitize.ts`).
 *
 * DERIVED FROM `RENDER_LAYER_MODULES`, never written out again. It was a hand
 * kept literal, and the two drifted exactly as a duplicated list does: the
 * registry named `briefing/questions.ts` and `briefing/ghost.ts` as render
 * layer while this pattern still listed three briefing modules, so a module
 * reaching either of those was flagged by nothing and §4.4's "a new render
 * file that skips registration is a RED BUILD" was not true of them.
 */
const RENDER_LAYER_SPECIFIER = new RegExp(
  `(?:${RENDER_LAYER_MODULES.map((module) =>
    module.replace(/^src\//, "").replace(/\./g, "\\."),
  ).join("|")})$`,
);

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
  "quotedBody",
  "spanRedactedUntrusted",
  "redactionNote",
  "REDACTED_TITLE",
  "REDACTED_SPAN",
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
  "formatIntentLabel",
  "intentFragment",
  "renderIntent",
  "formatGhostLine",
  "formatGhostAge",
  "renderGhostNotice",
  "ghostAttribution",
  "ghostDraftBody",
  "formatQuestionEntry",
  "fitQuestionEntries",
]);

/** import/export-from statements: clause + specifier. */
const IMPORT_PATTERN =
  /(?:import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g;

/** Dynamic `import("…")` / `require("…")` — no `from`, still a reach. */
const DYNAMIC_IMPORT_PATTERN =
  /\b(?:import|require)\s*\(\s*["'`]([^"'`]+)["'`]/g;

/** `* as alias` inside an import clause. */
const NAMESPACE_CLAUSE = /\*\s+as\s+([A-Za-z_$][\w$]*)/;

/**
 * Specifiers the render layer is reachable through: this workspace's own
 * modules. Namespace-member detection is scoped to these so `z.string` off
 * `import * as z from "zod"` cannot false-positive.
 */
const LOCAL_SPECIFIER = /^(?:\.|@crosscheck\/)/;

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

/** True when the module reaches render-layer VALUES (type-only is exempt). */
const touchesRenderLayer = (source: string): boolean => {
  const namespaceAliases: string[] = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const [, typeOnly, clause, specifier] = match;
    if (typeOnly !== undefined || clause === undefined || specifier === undefined) {
      continue;
    }
    if (RENDER_LAYER_SPECIFIER.test(specifier)) {
      // A value import from a render-layer module; names may be empty for
      // namespace imports (`* as`), which flag too.
      return true;
    }
    if (importedNames(clause).some((name) => RENDER_IDENTIFIERS.has(name))) {
      return true;
    }
    const namespace = NAMESPACE_CLAUSE.exec(clause);
    if (namespace?.[1] !== undefined && LOCAL_SPECIFIER.test(specifier)) {
      namespaceAliases.push(namespace[1]);
    }
  }
  for (const match of source.matchAll(DYNAMIC_IMPORT_PATTERN)) {
    const specifier = match[1];
    if (specifier !== undefined && RENDER_LAYER_SPECIFIER.test(specifier)) {
      return true;
    }
  }
  // `import * as core from "./index.ts"; core.sanitizeUntrusted(…)` — the
  // barrel dodge: the specifier is a barrel, the braced names are empty, and
  // only the member access names the render layer.
  for (const alias of namespaceAliases) {
    const memberPattern = new RegExp(`\\b${alias}\\.([A-Za-z_$][\\w$]*)`, "g");
    for (const member of source.matchAll(memberPattern)) {
      if (member[1] !== undefined && RENDER_IDENTIFIERS.has(member[1])) {
        return true;
      }
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

/**
 * Per-package exemptions beyond the default. connector-core is the render
 * layer's home, so the layer and its barrels are exempt there; every other
 * package gets exactly one structural exemption — its own registry file,
 * which names render identifiers in comments/adapters and IS the
 * registration. A new package wanting more has to say so here, loudly.
 */
const KNOWN_EXEMPT: Readonly<Record<string, readonly string[]>> = {
  "connector-core": [...RENDER_LAYER_MODULES, ...RENDER_BARREL_MODULES],
};
const DEFAULT_EXEMPT: readonly string[] = ["src/render-surfaces.ts"];

/**
 * The package walk itself moved to fixtures/registry-packages.ts when the
 * anchoring-separation test needed the same one; what stays here is the part
 * that is this file's own — which modules are exempt from registration.
 */
const PACKAGES: readonly PackageRegistration[] = REGISTERED_PACKAGES.map(
  (pkg) => ({
    ...pkg,
    exempt: KNOWN_EXEMPT[pkg.label] ?? DEFAULT_EXEMPT,
  }),
);

const ALL_SURFACES: readonly RenderSurface[] = ALL_REGISTERED_SURFACES;

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
  test("package discovery found the workspace — the walk cannot silently go blind", () => {
    // The floor: the five packages with surfaces today (Block 8 moved the
    // bin's doctor/status surfaces into packages/cli). A discovery that
    // lost one (moved root, renamed dirs) must fail HERE, not pass vacuously.
    const labels = PACKAGES.map((pkg) => pkg.label);
    expect(labels).toContain("connector-core");
    expect(labels).toContain("connector-claude");
    expect(labels).toContain("connector-acp");
    expect(labels).toContain("connector-cursor");
    expect(labels).toContain("cli");
  });

  test("the specifier pattern matches EVERY module the registry calls render layer", () => {
    // The meta-test can only flag an import it recognises, so this pattern IS
    // the coverage of the rule above. It was written out by hand beside the
    // list it mirrors, and drifted: briefing/questions.ts (R2) and
    // briefing/ghost.ts (VISION §3) joined RENDER_LAYER_MODULES while the
    // pattern still named three briefing modules, so a module rendering a
    // question entry or a ghost line was flagged by nothing at all.
    for (const module of RENDER_LAYER_MODULES) {
      const path = module.replace(/^src\//, "");
      expect(RENDER_LAYER_SPECIFIER.test(`../${path}`), module).toBe(true);
      expect(
        RENDER_LAYER_SPECIFIER.test(`@crosscheck/connector-core/${path}`),
        module,
      ).toBe(true);
    }
    // And still only those: a neighbouring module of the same shape is not
    // render layer, or every importer in the workspace would need a row.
    expect(RENDER_LAYER_SPECIFIER.test("../briefing/cut.ts")).toBe(false);
  });

  test("every render name a BARREL re-exports is one the meta-test flags", async () => {
    // RENDER_IDENTIFIERS is the whole coverage of the barrel route. A module
    // reaching the render layer through a relative or cross-package path is
    // caught by RENDER_LAYER_SPECIFIER, but src/index.ts and src/kit.ts are
    // themselves RENDER_BARREL_MODULES and therefore exempt from the specifier
    // rule — so an import through them is caught by NAME or by nothing.
    //
    // Hand-kept, that set drifts the moment a barrel re-exports a new render
    // value, exactly as RENDER_LAYER_SPECIFIER drifted from RENDER_LAYER_MODULES
    // before it was derived. Derived here for the same reason: the barrels and
    // the render layer are both read, and their intersection is the rule.
    const layerValues = new Set<string>();
    for (const module of RENDER_LAYER_MODULES) {
      const loaded: Record<string, unknown> = await import(
        join(CORE_ROOT, module)
      );
      for (const [name, value] of Object.entries(loaded)) {
        if (typeof value === "function" || typeof value === "string") {
          layerValues.add(name);
        }
      }
    }
    // A render layer with no value exports would make this test vacuous.
    expect(layerValues.size).toBeGreaterThan(0);

    const unflagged: string[] = [];
    for (const barrel of RENDER_BARREL_MODULES) {
      const loaded: Record<string, unknown> = await import(
        join(CORE_ROOT, barrel)
      );
      for (const name of Object.keys(loaded)) {
        if (layerValues.has(name) && !RENDER_IDENTIFIERS.has(name)) {
          unflagged.push(`${barrel} re-exports ${name}`);
        }
      }
    }

    expect(
      unflagged.sort(),
      `render value(s) reachable through a barrel but absent from RENDER_IDENTIFIERS: ${unflagged.join(", ")} — ` +
        "add the name, or the barrel route into the render layer is unguarded",
    ).toEqual([]);
  });

  test("the ACP and Cursor injection surfaces stay registered by NAME — module cover is not surface cover", () => {
    // Each connector's three surfaces share ONE module (ACP:
    // src/inject/blocks.ts; Cursor: src/inject/output.ts), so the
    // module-granular meta-test stays green when ONE registration is
    // deleted (its siblings keep the module allow-listed) and the corpus
    // floor never trips — proven empirically in the Block-5 review. The day
    // the wrappers diverge per surface, a dropped registration would drop
    // that framing's corpus coverage silently; this named floor is what
    // makes it a red build instead.
    const names = new Set(ALL_SURFACES.map((surface) => surface.name));
    for (const required of [
      "acp-briefing-block",
      "acp-claim-hint-block",
      "acp-pointer-hint-block",
      "cursor-briefing-context",
      "cursor-claim-hint-context",
      "cursor-pointer-hint-context",
    ]) {
      expect(names.has(required), required).toBe(true);
    }
  });

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

describe("§4.4: composite registrations are verified, not trusted", () => {
  const CORPUS_MARKERS = /INJECTION_CORPUS|assertUntrustedCharacters/;
  const TEST_FILE_IN_NOTE = /test\/[\w.-]+\.test\.ts/g;

  test("every corpusCoveredBy file exists and really runs the corpus or invariants", async () => {
    // A composite's exemption from corpus iteration rests on this claim, so
    // the claim is machine-checked: the named test file must exist AND import
    // the corpus or the shared invariant assertions. A registration pointing
    // at a contract-message test would be a lie the build now catches.
    for (const pkg of PACKAGES) {
      for (const surface of pkg.surfaces) {
        if (surface.kind !== "composite") {
          continue;
        }
        for (const file of surface.corpusCoveredBy ?? []) {
          const named = Bun.file(join(pkg.root, file));
          const where = `${pkg.label}: ${surface.name} → ${file}`;
          expect(await named.exists(), `${where} does not exist`).toBe(true);
          expect(
            CORPUS_MARKERS.test(await named.text()),
            `${where} runs neither INJECTION_CORPUS nor assertUntrustedCharacters`,
          ).toBe(true);
        }
      }
    }
  });

  test("prose notes cannot smuggle the coverage claim past the check", async () => {
    for (const pkg of PACKAGES) {
      for (const surface of pkg.surfaces) {
        if (surface.kind !== "composite") {
          continue;
        }
        // The phrase is banned from prose — the claim lives ONLY in
        // corpusCoveredBy, where the test above verifies it.
        expect(
          surface.note.includes("corpus-covered"),
          `${pkg.label}: ${surface.name} claims corpus coverage in prose — move it to corpusCoveredBy`,
        ).toBe(false);
        // Any test file a note names must at least exist (staleness guard).
        for (const named of surface.note.match(TEST_FILE_IN_NOTE) ?? []) {
          expect(
            await Bun.file(join(pkg.root, named)).exists(),
            `${pkg.label}: ${surface.name} note names missing ${named}`,
          ).toBe(true);
        }
      }
    }
  });
});
