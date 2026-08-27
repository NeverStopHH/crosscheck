/**
 * What the FTS document is allowed to contain (audit rows M12-rest and M13).
 *
 * Two defects, one document. MEASURED on this tree's own PGlite before either
 * was fixed, with `to_tsvector('english', …)`:
 *
 *   'chore/remove-agent-internal-auth-bypass @ api'
 *     → 'api':2 'chore/remove-agent-internal-auth-bypass':1
 *   'packages/connector-core/src/hints/select.ts'
 *     → 'packages/connector-core/src/hints/select.ts':1
 *   'main @ api' → 'api':2 'main':1
 *
 * The default parser recognises a branch name and a path as ONE `file` token,
 * so a teammate searching "auth bypass" matched nothing (M12-rest) — while
 * `main` and the repo label, which every context on the repo carries and which
 * say nothing about what anybody is doing, matched EVERYTHING (M13).
 *
 * The last two assertions run through the REAL generated tsvector column, not
 * through a re-typed copy of the rule: a doc that reads right and indexes
 * wrong is the whole defect.
 */
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { workContexts } from "../src/db/schema.ts";
import { buildNormalizedDoc } from "../src/services/normalized-doc.ts";
import {
  createHarnessWithSession,
  postRecords,
  recordEnvelope,
  validWorkContextBody,
  WORK_CONTEXT_ID,
} from "./helpers.ts";
import type { TestHarness } from "./helpers.ts";

/** The doc as the tsvector sees it: does the stored row match this query? */
const matches = async (
  harness: TestHarness,
  query: string,
): Promise<boolean> => {
  const rows = await harness.db
    .select({
      hit: sql<boolean>`${workContexts.tsv} @@ websearch_to_tsquery('english', ${query})`,
    })
    .from(workContexts)
    .where(eq(workContexts.id, WORK_CONTEXT_ID))
    .limit(1);
  return rows[0]?.hit === true;
};

const docFor = (
  title: string,
  repoLabel: string | null,
  targetValues: readonly string[] = [],
): string =>
  buildNormalizedDoc({
    title,
    status: "analyzing",
    intentSummary: null,
    description: null,
    targetValues,
    claimSummaries: [],
    repoLabel,
  });

/** The doc's words, as a set — the bag the tsvector is built from. */
const wordsOf = (doc: string): ReadonlySet<string> =>
  new Set(doc.split(/\s+/).filter((word) => word.length > 0));

describe("the FTS document splits identifiers into words (M12-rest)", () => {
  test("a branch-name title is searchable by the words inside it", () => {
    // Arrange / Act
    const doc = docFor("chore/remove-agent-internal-auth-bypass @ api", "api");

    // Assert: the whole branch name STILL indexes (this adds reach, it does
    // not trade one spelling for another — GitHub's own code index keeps the
    // original token beside the parts), and the parts are now words.
    expect(doc).toContain("chore/remove-agent-internal-auth-bypass");
    const words = wordsOf(doc);
    for (const part of ["chore", "remove", "agent", "internal", "auth", "bypass"]) {
      expect(words).toContain(part);
    }
  });

  test("a file path is searchable by its segments and its file name", () => {
    const doc = docFor("Login 500s on staging", "api", [
      "packages/connector-core/src/hints/select.ts",
    ]);
    expect(doc).toContain("packages/connector-core/src/hints/select.ts");
    const words = wordsOf(doc);
    for (const part of ["connector", "core", "hints", "select"]) {
      expect(words).toContain(part);
    }
  });

  test("build layout and file types are not topics", () => {
    // MEASURED, not assumed. Indexing `src`, `packages` and `ts` turned the
    // golden precision corpus red on two probes — auth-jwt/pr_auth_self and
    // ws-proposed/pr_ws_pointer — because this pipeline's precision floor is
    // TIER MEMBERSHIP: one shared FTS token qualifies a context, and every
    // repo's every path carries those three words, so any prompt naming any
    // file matched every context on the hub.
    const words = wordsOf(
      docFor("Login 500s on staging", "api", [
        "packages/connector-core/src/hints/select.ts",
      ]),
    );
    for (const scaffolding of ["packages", "src", "ts"]) {
      expect(words).not.toContain(scaffolding);
    }
  });

  test("camelCase and snake_case identifiers split into their parts", () => {
    const words = wordsOf(
      docFor("Login 500s on staging", "api", [
        "selectHint",
        "hint_deliveries",
        "XMLHttpRequest",
      ]),
    );
    for (const part of ["select", "Hint", "hint", "deliveries", "XML", "Http", "Request"]) {
      expect(words).toContain(part);
    }
  });

  test("one-letter fragments and repeated segments cost the doc nothing", () => {
    // Three paths repeat `alpha`; a doc that pays for each copy spends the
    // character cap on nothing. And `a` in `alpha/a/one.md` is noise the
    // english config drops at index time — not worth a byte here either.
    const doc = docFor("Login 500s on staging", "api", [
      "alpha/a/one.md",
      "alpha/b/two.md",
      "alpha/c/three.md",
    ]);
    // Once in each of the three verbatim target lines, once in the token bag.
    expect(doc.split(/\balpha\b/).length - 1).toBe(4);
    expect(wordsOf(doc)).not.toContain("a");
  });

  test("the derived tokens are bounded, so a sweep context cannot fill the doc", () => {
    const many = Array.from(
      { length: 100 },
      (_unused, index) =>
        `packages/pkg-${String(index)}/src/module-${String(index)}/file-${String(index)}.ts`,
    );
    const withTokens = docFor("Login 500s on staging", "api", many);
    const withoutTokens = docFor("Login 500s on staging", "api", []);
    const verbatimCost = many.join("\n").length + 1;
    // The control: tokens ARE produced here, so the bound below is a bound on
    // something. Without it an empty token bag satisfies every assertion.
    expect(wordsOf(withTokens)).toContain("module");
    // The token bag has a bound of its own, far under the doc cap: the claim
    // summaries at the end of the doc must not be evicted by path words.
    expect(withTokens.length - withoutTokens.length - verbatimCost).toBeLessThanOrEqual(600);
  });
});

describe("the FTS document keeps the repo label and the default branch out (M13)", () => {
  test("the ' @ <repo>' suffix the connector appends is not in the doc", () => {
    // Control first: the branch half of the same title IS in the doc, so this
    // is a rule about the label and not about the title being dropped.
    const doc = docFor("feat/auth-refresh @ api", "api");
    expect(wordsOf(doc)).toContain("auth");
    expect(wordsOf(doc)).not.toContain("api");
    expect(doc).not.toContain("@ api");
  });

  test("a title that is only the default branch contributes nothing", () => {
    const doc = docFor("main @ api", "api");
    expect(wordsOf(doc)).not.toContain("main");
    // …and the doc still carries everything else it is built from.
    expect(doc).toContain("analyzing");
  });

  test("a real title that merely contains the word main is untouched", () => {
    // The precision half: `main` is dropped as a BRANCH LABEL, never as a word
    // somebody wrote. Without this the fix would cost more than M13 buys.
    const doc = docFor("the main loop deadlocks on the second flush @ api", "api");
    // The control on the same doc: the LABEL half of the rule did run here,
    // so "main survived" is a decision and not an untouched document.
    expect(wordsOf(doc)).not.toContain("api");
    expect(wordsOf(doc)).toContain("main");
  });

  test("a local: repo has no label to strip and keeps its whole title", () => {
    const doc = docFor("feat/auth-refresh", null);
    expect(doc).toContain("feat/auth-refresh");
    expect(wordsOf(doc)).toContain("auth");
  });
});

describe("through the real generated tsvector", () => {
  test("a branch-name title matches the words in it and not the repo label", async () => {
    // Arrange
    const { harness, developer } = await createHarnessWithSession();

    // Act: the ordinary ingest path, which builds and stores the doc.
    await postRecords(
      harness,
      developer,
      recordEnvelope(
        "work_context",
        validWorkContextBody({
          title: "chore/remove-agent-internal-auth-bypass @ api",
          description: undefined,
        }),
      ),
    );

    // Assert
    expect(await matches(harness, "auth bypass")).toBe(true);
    expect(await matches(harness, "api")).toBe(false);
  });

  test("a session on main is not the answer to «rebase onto main»", async () => {
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(
      harness,
      developer,
      recordEnvelope(
        "work_context",
        validWorkContextBody({ title: "main @ api", description: undefined }),
      ),
    );
    // The control: this row exists and is findable by what it really says.
    expect(await matches(harness, "analyzing")).toBe(true);
    expect(await matches(harness, "rebase onto main")).toBe(false);
    expect(await matches(harness, "main")).toBe(false);
  });
});
