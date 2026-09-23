/**
 * INT-7 — THE LEDGER AUTHORISES NOTHING.
 *
 * An agent that widens its own intent authorises itself. So the value of
 * `work_context_intents` is the CLOCK — where in its own session a sentence was
 * written — and never the CONTENT: no predicate anywhere may read "the current
 * intent covers X, therefore X is fine". That rule is one import away from
 * being broken by a well-meaning change, and a broken one reads correctly in
 * every test that does not ask this question, because the wrong answer is the
 * PERMISSIVE one. A fence that consults the ledger stops firing; nothing goes
 * red; the surface that told you so is the one that stopped telling you.
 *
 * So the rule is enforced structurally rather than reviewed: every `src` module
 * of EVERY workspace package is walked, and any module reaching the two tables
 * that is not the definition site or the single consumer fails the build.
 *
 * PACKAGES ARE DISCOVERED, NOT ENUMERATED — the same reason
 * render-surface-registry.test.ts gives: a connector added tomorrow is walked
 * the day its directory appears, and a list of package names inside a test file
 * is a second registry that drifts from the first.
 *
 * FOUR DOORS ARE CHECKED, not one: a static import, a dynamic `import()`, a
 * `require()`, and the barrel dodge — a namespace import of a module that
 * re-exports the tables, reached by member access. A re-export is itself a
 * violation here, because a second door with a different name is still a second
 * door; `db/schema.ts` is the only place either identifier may be spelled
 * outside the consumer.
 *
 * TYPE-ONLY IMPORTS ARE EXEMPT, and the exemption is narrow on purpose: a type
 * cannot run a query. `typeof workContextIntents.$inferSelect` describes a row
 * that some other module already read; it cannot itself read one.
 *
 * PROVEN TO BITE, twice, before this file was written down: a scratch
 * `packages/server/src/services/scratch-authority.ts` importing
 * `workContextIntents` from `../db/schema.ts` was red, and so was a scratch
 * re-export barrel reached by namespace member access from a second module.
 * Both were removed. A meta-test nobody has watched fail is a meta-test that
 * passes because its walk found nothing at all.
 */
import { describe, expect, test } from "bun:test";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const WORKSPACE_PACKAGES_ROOT = join(import.meta.dir, "..", "..");

/** The two tables. Spelling either one outside the exempt set is the defect. */
const LEDGER_IDENTIFIERS = new Set(["workContextIntents", "intentScope"]);

/**
 * THE LEDGER'S EXPORTED READERS — because guarding the table names guards a
 * SPELLING, and the rule is about ACCESS.
 *
 * The first version of this file matched `workContextIntents` and
 * `intentScope` only. A module that imports `readIntentChain` from the
 * consumer reaches every summary, reason and scope entry without spelling
 * either table once, so the walk saw nothing — and `services/diagnosis.ts`
 * was already doing exactly that in the shipped tree. The test could not tell
 * a renderer from a gate, which is the distinction INT-7 exists to make: a
 * fence that consulted the ledger would have stayed green, and the wrong
 * answer there is the permissive one.
 *
 * So the readers are named too, and every module that calls one has to be on
 * the list below with its reason.
 */
const LEDGER_READERS = new Set([
  "readIntentChain",
  "explanationTimingFor",
  "explanationTimingOf",
  "countIntentPositions",
]);

/**
 * Modules permitted to call a ledger reader, and what each is permitted FOR.
 *
 * Every entry is a render or report path. None of them decides anything: a
 * renderer shows a reader the history, a doctor line counts rows. No verdict,
 * fence or hint path appears here, and adding one is the decision INT-7
 * exists to force into the open rather than let happen by import.
 */
const READER_CALLERS = new Map<string, string>([
  [
    "packages/server/src/services/diagnosis.ts",
    "renders the chain onto the diagnosis document (§5) — it ships rows to a " +
      "reader and gates nothing",
  ],
  [
    "packages/server/src/services/suspect.ts",
    "renders the timing clause beside a candidate's declared intent (§5, " +
      "decision 10.2) — it changes no ranking, no gate and nobody's place in " +
      "the list, which is the distinction INT-7 exists to keep visible: this " +
      "is the one entry where a reader should check that for themselves",
  ],
  [
    "packages/server/src/routes/intent-ledger.ts",
    "serves the doctor ratio (§5) — two integers about whether this hub can " +
      "answer AT-4 at all, with no work context, no session and no sentence, " +
      "and no predicate anywhere reads them",
  ],
]);

/**
 * The definition site and the one consumer, as repo-relative paths.
 *
 * `db/schema.ts` declares the tables; `services/intent-ledger.ts` is the only
 * module §3.5 permits to read them. Adding a third entry here is a decision
 * about the architecture, which is why it is a two-line list in the test rather
 * than a pattern that could quietly widen.
 */
const EXEMPT = new Set([
  "packages/server/src/db/schema.ts",
  "packages/server/src/services/intent-ledger.ts",
]);

const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

/** Every packages/<name>/src tree on disk, in name order. */
const discoverPackageRoots = async (): Promise<readonly string[]> => {
  const entries = await readdir(WORKSPACE_PACKAGES_ROOT, {
    withFileTypes: true,
  });
  const roots: string[] = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
    const root = join(WORKSPACE_PACKAGES_ROOT, entry.name);
    if (await isDirectory(join(root, "src"))) {
      roots.push(root);
    }
  }
  return roots.sort();
};

const listSourceFiles = async (root: string): Promise<readonly string[]> => {
  const entries = await readdir(join(root, "src"), {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
};

/**
 * Comments are stripped before anything is matched, so this file's own prose —
 * and every other module's — cannot be mistaken for a reference. Without it the
 * walk reports a doc comment naming the table as a consumer, and the first
 * person to hit that false positive deletes the test rather than the comment.
 */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

interface Reference {
  readonly file: string;
  readonly how: string;
}

/**
 * A static or type-only import statement, split into its `type` marker, its
 * clause and its specifier. Written as one regex over comment-free source
 * rather than a parse, because the shapes that matter are all one statement.
 */
const STATIC_IMPORT =
  /\bimport\s+(type\s+)?(\{[^}]*\}|\*\s+as\s+[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*)\s+from\s*["']([^"']+)["']/g;
const REEXPORT =
  /\bexport\s+(type\s+)?(\{[^}]*\}|\*)\s+from\s*["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const REQUIRE = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

const namesLedger = (clause: string): boolean =>
  [...clause.matchAll(/[A-Za-z_$][\w$]*/g)].some(
    (match) => match[0] !== undefined && LEDGER_IDENTIFIERS.has(match[0]),
  );

/** Which ledger readers a clause imports, if any. */
const readersIn = (clause: string): readonly string[] =>
  [...clause.matchAll(/[A-Za-z_$][\w$]*/g)]
    .map((match) => match[0])
    .filter((name): name is string => name !== undefined && LEDGER_READERS.has(name));

/**
 * Every way a module can reach the two tables, from one file's source.
 *
 * A dynamic import or a `require` of the schema module is reported on the
 * specifier alone: what it destructures afterwards is a second statement, and a
 * module that pulls in the schema at runtime has already opened the door this
 * test exists to keep shut.
 */
const referencesIn = (source: string): readonly string[] => {
  const clean = withoutComments(source);
  const found: string[] = [];
  const namespaceAliases: string[] = [];

  for (const match of clean.matchAll(STATIC_IMPORT)) {
    const [, typeOnly, clause = "", specifier = ""] = match;
    const namespace = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(clause);
    if (namespace?.[1] !== undefined && typeOnly === undefined) {
      namespaceAliases.push(namespace[1]);
    }
    if (typeOnly !== undefined) {
      continue;
    }
    // `import { type workContextIntents }` is a type import wearing a value
    // clause; the inline marker is what makes it one.
    const valueNames = clause
      .replace(/^\{|\}$/g, "")
      .split(",")
      .filter((name) => !/^\s*type\s/.test(name))
      .join(",");
    if (namesLedger(valueNames)) {
      found.push(`static import from ${specifier}`);
    }
    // The second door, and the one the first version of this file could not
    // see: importing a READER reaches every row the tables hold without
    // spelling either table name.
    for (const reader of readersIn(valueNames)) {
      found.push(`reads the ledger via ${reader}()`);
    }
  }

  for (const match of clean.matchAll(REEXPORT)) {
    const [, typeOnly, clause = "", specifier = ""] = match;
    if (typeOnly !== undefined) {
      continue;
    }
    if (namesLedger(clause)) {
      found.push(`re-export from ${specifier}`);
    }
  }

  for (const match of clean.matchAll(DYNAMIC_IMPORT)) {
    if ((match[1] ?? "").endsWith("db/schema.ts")) {
      found.push(`dynamic import of ${match[1] ?? ""}`);
    }
  }

  for (const match of clean.matchAll(REQUIRE)) {
    if ((match[1] ?? "").endsWith("db/schema.ts")) {
      found.push(`require of ${match[1] ?? ""}`);
    }
  }

  // The barrel dodge: the braced names are innocent, the specifier is a
  // barrel, and only the member access names a table — OR A READER.
  //
  // THE SECOND HALF WAS MISSING, and an independent refuter walked through
  // it. This loop asked `LEDGER_IDENTIFIERS` (the two table names) and never
  // `LEDGER_READERS`, while the braced-import branch forty lines up asks
  // both — so `import * as ledger` followed by `ledger.explanationTimingFor(…)`
  // reached every row the tables hold and the build stayed green. Measured:
  //
  //   braced      import { readIntentChain } …        1 fail   (caught)
  //   namespace   ledger.readIntentChain(…)           0 fail   (not caught)
  //   namespace   ledger.explanationTimingFor(…)      0 fail   (not caught)
  //   re-export   laundered through a listed caller   0 fail   (not caught)
  //
  // This file's own comment says of exactly this case that "the wrong answer
  // there is the PERMISSIVE one": a fence consulting the ledger stops
  // refusing, nothing goes red, and an agent widening its own intent
  // authorises itself. A door a test names as closed and does not close is
  // worse than one it never mentions — a reader stops looking.
  for (const alias of namespaceAliases) {
    const member = new RegExp(`\\b${alias}\\.([A-Za-z_$][\\w$]*)`, "g");
    for (const use of clean.matchAll(member)) {
      if (use[1] === undefined) {
        continue;
      }
      if (LEDGER_IDENTIFIERS.has(use[1])) {
        found.push(`namespace member ${alias}.${use[1]}`);
      }
      if (LEDGER_READERS.has(use[1])) {
        found.push(`reads the ledger via namespace member ${alias}.${use[1]}()`);
      }
    }
  }

  return found;
};

describe("INT-7 — the ledger authorises nothing", () => {
  test("no module outside the consumer reaches the two ledger tables", async () => {
    const roots = await discoverPackageRoots();
    // The walk finding nothing would make every assertion below vacuous, so
    // the walk itself is asserted first: the packages exist and the exempt
    // files are among the files actually read.
    expect(roots.length).toBeGreaterThanOrEqual(7);

    const walked: string[] = [];
    const violations: Reference[] = [];
    for (const root of roots) {
      for (const absolute of await listSourceFiles(root)) {
        const file = relative(
          join(WORKSPACE_PACKAGES_ROOT, ".."),
          absolute,
        );
        walked.push(file);
        if (EXEMPT.has(file)) {
          continue;
        }
        const permittedReader = READER_CALLERS.has(file);
        for (const how of referencesIn(await Bun.file(absolute).text())) {
          // A module on READER_CALLERS may call a reader and nothing else:
          // it is still forbidden to touch the tables directly, because that
          // would be a second door under an exemption granted for the first.
          if (permittedReader && how.startsWith("reads the ledger via ")) {
            continue;
          }
          violations.push({ file, how });
        }
      }
    }

    // Both exempt paths must have been walked. An exemption for a file the
    // walk never reaches is an exemption that hides nothing and proves the
    // path spelling has rotted.
    for (const exempt of EXEMPT) {
      expect(walked).toContain(exempt);
    }
    expect(walked.length).toBeGreaterThan(100);

    expect(
      violations.map((violation) => `${violation.file}: ${violation.how}`),
    ).toEqual([]);
  });

  test("every reader exemption still covers something", async () => {
    // AN EXEMPTION THAT HIDES NOTHING IS WORSE THAN NO EXEMPTION: it reads as
    // a considered decision while guarding an import somebody removed months
    // ago, and the next module to need one finds a list that looks permissive.
    for (const [file, reason] of READER_CALLERS) {
      const absolute = join(WORKSPACE_PACKAGES_ROOT, "..", file);
      const source = await Bun.file(absolute).text();
      const doors = referencesIn(source).filter((how) =>
        how.startsWith("reads the ledger via "),
      );
      expect(doors).not.toEqual([]);
      // And the reason is a sentence, not a shrug.
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  test("the consumer itself is found by the walk it is exempt from", async () => {
    // Guards the inverse failure: an EXEMPT entry that matches nothing, or a
    // detector that would not have flagged the consumer either. If
    // intent-ledger.ts stopped being detectable, every other module could stop
    // being detectable for the same reason and this file would still be green.
    const consumer = join(
      WORKSPACE_PACKAGES_ROOT,
      "server",
      "src",
      "services",
      "intent-ledger.ts",
    );
    expect(referencesIn(await Bun.file(consumer).text())).not.toEqual([]);
  });

  test("each door is detected on a synthetic module", () => {
    // The four shapes, as source rather than as files: the walk above can only
    // prove the absence of violations, never that it would have seen one.
    expect(
      referencesIn('import { workContextIntents } from "../db/schema.ts";'),
    ).not.toEqual([]);
    expect(
      referencesIn('export { intentScope } from "../db/schema.ts";'),
    ).not.toEqual([]);
    expect(
      referencesIn('const s = await import("../db/schema.ts");'),
    ).not.toEqual([]);
    expect(referencesIn('const s = require("../db/schema.ts");')).not.toEqual(
      [],
    );
    expect(
      referencesIn(
        'import * as barrel from "./barrel.ts";\nbarrel.workContextIntents;',
      ),
    ).not.toEqual([]);
    // And the exemptions, so the detector is not simply always-true.
    expect(
      referencesIn('import type { workContextIntents } from "../db/schema.ts";'),
    ).toEqual([]);
    expect(
      referencesIn('/* workContextIntents is read by intent-ledger.ts */'),
    ).toEqual([]);
    expect(referencesIn('import { claims } from "../db/schema.ts";')).toEqual(
      [],
    );
  });
});
