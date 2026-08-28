/**
 * THE DERIVE RUNGS' META-TEST — §4.4's shape, pointed at a different lie.
 *
 * The render registry stops a connector RENDERING untrusted text without
 * declaring it. This stops a connector INFERRING without declaring it, and —
 * the half that matters more for a doctor line — declaring an inference it
 * does not actually ship. Both directions are red, because both produce the
 * same outcome for a reader: a sentence in `doctor` that is not true of the
 * machine in front of them.
 *
 *   UNDECLARED TRIGGER. A package that imports a derive trigger for
 *   capability X and does not declare X is the silent-absence failure rule 4
 *   forbids: the machinery fires, the fires are booked, and no surface says
 *   the capability exists on this host at all.
 *
 *   UNDELIVERED DECLARATION. A package that declares X `full` and ships
 *   nothing for it is worse than silence — `doctor` states a capability the
 *   developer then waits for. This is the direction that would have caught
 *   the whole gap this work exists to close, from the other side: before
 *   this step connector-cursor could have claimed anything.
 *
 * CONFERENCE IS EXEMPT FROM THE TRIGGER EVIDENCE, and exempt with a check
 * rather than on trust: it is a command a human runs (packages/cli), not a
 * hook, so "full" on a connector is a statement that the command has NO host
 * coupling — asserted below by the absence of conference code in every
 * connector package plus the presence of the CLI command.
 */
import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import { DERIVE_CAPABILITIES } from "../src/derive/capabilities.ts";
import type {
  DeriveCapabilityManifest,
  DeriveCapabilityName,
} from "../src/derive/capabilities.ts";

const WORKSPACE_PACKAGES_ROOT = join(import.meta.dir, "..", "..");

/**
 * The identifiers that MAKE a connector infer. Importing any of them is
 * shipping that capability's trigger; a connector cannot reach the machinery
 * another way, because every entry point into core/src/derive is here.
 */
const TRIGGER_IDENTIFIERS: Readonly<
  Record<DeriveCapabilityName, readonly string[]>
> = {
  intent: ["runIntentWorker", "withIntentFire", "isSubstantivePrompt"],
  ghost: ["runGhostWorker", "withGhostClaimed", "hasGhostAllowance"],
  summarizer: [
    "deriveFromSlice",
    "withSummarizerFire",
    "isCaptureMoment",
    "withSummarizerNoSlice",
  ],
  conference: [],
};

/** Barrels re-export names without using them — the render registry's rule. */
const BARRELS = new Set(["src/index.ts", "src/kit.ts", "src/render-surfaces.ts"]);

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
    .map((entry) => (entry.split(/\s+as\s+/)[0] ?? entry).trim());
};

/** `* as alias` inside an import clause — the namespace dodge. */
const NAMESPACE_CLAUSE = /\*\s+as\s+([A-Za-z_$][\w$]*)/;
const LOCAL_SPECIFIER = /^(?:\.|@crosscheck\/)/;

/**
 * Every trigger name this module reaches, braced OR through a namespace.
 *
 * The namespace half is not hypothetical: `import * as gate from
 * ".../ghost/gate.ts"; gate.hasGhostAllowance(state)` ships the ghost trigger
 * with no braced name anywhere, and a checker that only reads braces calls
 * that package honest. It was written as a braces-only check first and the
 * dodge was proven to slip through before this was added — the same hole the
 * render registry's own meta-test found in Block 2.
 */
const valueImportsOf = (source: string): ReadonlySet<string> => {
  const names = new Set<string>();
  const namespaceAliases: string[] = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const [, typeOnly, clause, specifier] = match;
    if (typeOnly !== undefined || clause === undefined || specifier === undefined) {
      continue;
    }
    for (const name of importedNames(clause)) {
      names.add(name);
    }
    const namespace = NAMESPACE_CLAUSE.exec(clause);
    if (namespace?.[1] !== undefined && LOCAL_SPECIFIER.test(specifier)) {
      namespaceAliases.push(namespace[1]);
    }
  }
  for (const alias of namespaceAliases) {
    const memberPattern = new RegExp(`\\b${alias}\\.([A-Za-z_$][\\w$]*)`, "g");
    for (const member of source.matchAll(memberPattern)) {
      if (member[1] !== undefined) {
        names.add(member[1]);
      }
    }
  }
  return names;
};

const listSourceFiles = async (root: string): Promise<readonly string[]> => {
  try {
    const entries = await readdir(join(root, "src"), {
      recursive: true,
      withFileTypes: true,
    });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) =>
        join(
          "src",
          relative(join(root, "src"), join(entry.parentPath, entry.name)),
        ),
      )
      .sort();
  } catch {
    return [];
  }
};

interface ConnectorPackage {
  readonly label: string;
  readonly root: string;
  readonly manifest: DeriveCapabilityManifest | null;
}

const MANIFEST_EXPORTS: Readonly<Record<string, string>> = {
  "connector-claude": "CLAUDE_CAPABILITY_MANIFEST",
  "connector-cursor": "CURSOR_CAPABILITY_MANIFEST",
  "connector-acp": "ACP_CAPABILITY_MANIFEST",
};

const loadPackages = async (): Promise<readonly ConnectorPackage[]> => {
  const entries = await readdir(WORKSPACE_PACKAGES_ROOT, {
    withFileTypes: true,
  });
  const connectors = entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name.startsWith("connector-") &&
        // core is the machinery, not a host: it declares nothing because it
        // triggers nothing — every identifier below is DEFINED there.
        entry.name !== "connector-core",
    )
    .map((entry) => entry.name)
    .sort();
  return Promise.all(
    connectors.map(async (label) => {
      const root = join(WORKSPACE_PACKAGES_ROOT, label);
      const exportName = MANIFEST_EXPORTS[label];
      if (exportName === undefined) {
        return { label, root, manifest: null };
      }
      const module = (await import(join(root, "src", "capabilities.ts"))) as
        Record<string, DeriveCapabilityManifest | undefined>;
      return { label, root, manifest: module[exportName] ?? null };
    }),
  );
};

const PACKAGES = await loadPackages();

/** Capabilities this package's own (non-barrel) modules actually trigger. */
const shippedCapabilities = async (
  pkg: ConnectorPackage,
): Promise<ReadonlySet<DeriveCapabilityName>> => {
  const shipped = new Set<DeriveCapabilityName>();
  for (const file of await listSourceFiles(pkg.root)) {
    if (BARRELS.has(file)) {
      continue;
    }
    const names = valueImportsOf(
      await Bun.file(join(pkg.root, file)).text(),
    );
    for (const capability of DERIVE_CAPABILITIES) {
      if (TRIGGER_IDENTIFIERS[capability].some((name) => names.has(name))) {
        shipped.add(capability);
      }
    }
  }
  return shipped;
};

describe("the derive rungs are declared, and the declaration is true", () => {
  test("the walk found the connector packages — it cannot pass vacuously", () => {
    const labels = PACKAGES.map((pkg) => pkg.label);
    expect(labels).toContain("connector-claude");
    expect(labels).toContain("connector-cursor");
    expect(labels).toContain("connector-acp");
  });

  test.each(PACKAGES.map((pkg) => [pkg.label, pkg] as const))(
    "%s declares every capability it ships",
    async (label, pkg) => {
      // Arrange
      const shipped = await shippedCapabilities(pkg);

      // Assert
      const undeclared = [...shipped].filter(
        (capability) =>
          (pkg.manifest?.capabilities.find(
            (entry) => entry.name === capability,
          )?.rung ?? "off") === "off",
      );
      expect(
        undeclared,
        `${label} triggers ${undeclared.join(", ")} and declares neither — ` +
          "add it to src/capabilities.ts, or doctor can never say the capability exists here",
      ).toEqual([]);
    },
  );

  test.each(
    PACKAGES.filter((pkg) => pkg.manifest !== null).map(
      (pkg) => [pkg.label, pkg] as const,
    ),
  )("%s ships every capability it declares", async (label, pkg) => {
    // Arrange
    const shipped = await shippedCapabilities(pkg);
    const declared = (pkg.manifest?.capabilities ?? []).filter(
      (entry) => entry.rung !== "off" && entry.name !== "conference",
    );

    // Assert
    const undelivered = declared
      .map((entry) => entry.name)
      .filter((name) => !shipped.has(name));
    expect(
      undelivered,
      `${label} declares ${undelivered.join(", ")} but no module triggers it — ` +
        "a doctor line stating a capability nobody built is worse than silence",
    ).toEqual([]);
  });

  test("every declared rung carries a platform sentence, and no sentence is a roadmap", () => {
    for (const pkg of PACKAGES) {
      for (const entry of pkg.manifest?.capabilities ?? []) {
        expect(entry.sentence.length, `${pkg.label}/${entry.name}`).toBeGreaterThan(20);
        // A sentence that promises is a sentence that stops being true.
        for (const banned of ["soon", "planned", "will be", "not yet built"]) {
          expect(
            entry.sentence.toLowerCase().includes(banned),
            `${pkg.label}/${entry.name} promises: ${entry.sentence}`,
          ).toBe(false);
        }
      }
    }
  });

  test("conference is host-independent, so no connector may contain its code", async () => {
    // The exemption above, checked instead of trusted.
    for (const pkg of PACKAGES) {
      for (const file of await listSourceFiles(pkg.root)) {
        // Barrels re-export without using — a pass-through that keeps a
        // package's public surface stable is not a host coupling.
        if (BARRELS.has(file)) {
          continue;
        }
        const names = valueImportsOf(await Bun.file(join(pkg.root, file)).text());
        expect(
          names.has("resolveConferenceArgv") || names.has("renderConferenceInput"),
          `${pkg.label}/${file} reaches conference code — conference is a CLI command, not a connector trigger`,
        ).toBe(false);
      }
    }
    expect(
      await Bun.file(
        join(WORKSPACE_PACKAGES_ROOT, "cli", "src", "cli", "conference.ts"),
      ).exists(),
    ).toBe(true);
  });

  test("a connector that declares a capability off still says why", () => {
    for (const pkg of PACKAGES) {
      for (const entry of pkg.manifest?.capabilities ?? []) {
        if (entry.rung === "off") {
          expect(entry.sentence.length, `${pkg.label}/${entry.name}`).toBeGreaterThan(20);
        }
      }
    }
  });

  test("refusals are sentences a human can act on, not labels", () => {
    for (const pkg of PACKAGES) {
      for (const refusal of pkg.manifest?.refusals ?? []) {
        expect(refusal.name.length, pkg.label).toBeGreaterThan(3);
        expect(refusal.sentence.length, refusal.name).toBeGreaterThan(40);
      }
    }
  });
});
