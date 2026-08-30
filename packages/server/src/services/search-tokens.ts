/**
 * What the FTS document is allowed to contain, and in what form (DESIGN.md §6,
 * audit rows M12-rest and M13). One module because the two rules are the same
 * decision seen from both sides: WHICH characters of a work context are content
 * a teammate could search for, and which are labels this product itself put
 * there.
 *
 * THE MEASUREMENT THAT MOTIVATES IT, from this tree's own PGlite:
 *
 * VERIFY: bun -e 'const q=String.fromCharCode(39);const {createDb}=await import("./packages/server/src/index.ts");const db=await createDb();for(const s of ["chore/remove-agent-internal-auth-bypass @ api","packages/connector-core/src/hints/select.ts","main @ api"]){const r=await db.execute(`select to_tsvector(${q}english${q}, ${q}${s}${q}) as v`);console.log(r.rows[0].v)}'
 * PRINTS: 'api':2 'chore/remove-agent-internal-auth-bypass':1
 * PRINTS: 'packages/connector-core/src/hints/select.ts':1
 * PRINTS: 'api':2 'main':1
 *
 * A branch name and a path are ONE `file` token to the default parser, so
 * "auth bypass" matched neither — while `main` and the repo label, which every
 * context on the repo carries, matched every one of them.
 *
 * WHAT THIS ADOPTS AND WHAT IT DOES NOT. GitHub's code index splits on symbols
 * and then extracts CamelCase and snake_case parts as ADDITIONAL tokens,
 * keeping the original, and deliberately skips stemming; Elasticsearch's
 * `word_delimiter_graph` is the same idea with `preserve_original`. Both are
 * adopted: the verbatim title and the verbatim target values stay in the
 * document exactly as before and the parts are added beside them, so nothing
 * that matched yesterday stops matching. Two things are deliberately NOT
 * adopted: the letter-to-digit split (`XL500` → `XL`, `500`), because `500s`
 * and `v2` read as one thing to the human doing the searching, and any form of
 * stemming here — `to_tsvector('english', …)` already stems the whole document
 * one layer up, and stemming twice would index words nobody typed.
 *
 * THE QUERY SIDE IS NOT THIS FUNCTION, deliberately. `ftsTokens`
 * (services/search.ts) splits what the SEARCHER typed: lowercased, with the
 * query floor and the query cap, and no CamelCase split. That asymmetry is the
 * `preserve_original` arrangement itself — index the parts, search the words a
 * human typed — and merging the two would give the query side a cap it does
 * not want and this side a lowercase it must not have (the document keeps the
 * author's spelling; `to_tsvector` folds case downstream).
 */

/**
 * Shortest part worth indexing. A single letter (`src/a/one.ts` → `a`) is
 * noise the english configuration drops at index time anyway; paying a byte of
 * the document cap for it buys nothing.
 */
const TOKEN_MIN_CHARS = 2;

/**
 * The bound on the derived bag, in characters of the joined line.
 *
 * It is a bound on the DOCUMENT, not on the tokenizer: NORMALIZED_DOC_MAX_CHARS
 * cuts from the END, where the claim summaries live, so every character the bag
 * spends on a claim-heavy context is a character of somebody's recorded finding
 * that stops being searchable. 600 is 7.5 % of that cap and fits the
 * deduplicated parts of a hundred paths (measured in search-tokens.test.ts,
 * "the derived tokens are bounded").
 */
export const DERIVED_TOKENS_MAX_CHARS = 600;

/**
 * Parts that say WHERE code lives or WHAT TYPE a file is, never what the work
 * is about — dropped from the derived bag only, so the verbatim path is
 * untouched and the exact tier still matches `src/auth/refresh.ts` whole.
 *
 * THIS LIST IS NOT DECORATION; IT WAS MEASURED. Splitting paths without it
 * turned the golden precision corpus red on two probes at once
 * (test/fixtures/precision-corpus, run 2026-08-27):
 *
 *   auth-jwt/pr_auth_self       expected silence, observed substance
 *   ws-proposed/pr_ws_pointer   expected pointer, observed substance
 *
 * Both for the same reason. `src` and `ts` are parts of nearly every path on
 * every repo, so indexing them made every context a lexical match for every
 * prompt that names any file — and this pipeline's precision floor is TIER
 * MEMBERSHIP, not rank: one shared FTS token is enough to qualify a context,
 * after which an evidence-backed claim inside it is injected as substance
 * (the corpus states that openly at `pr_limits_oneword_debatable`). A search
 * engine absorbs `src` through IDF, which needs corpus-wide statistics; this
 * builder writes ONE row at ingest time and has none, so the same job is done
 * by a list — exactly as `to_tsvector('english', …)` does it for `the` and
 * `after` one layer up.
 *
 * The entries are therefore the words that would be at the top of an IDF
 * table for source paths: build-layout directories and file extensions.
 * Nothing here is a domain word. `internal`, `core`, `hints`, `auth` and
 * their kind stay indexed — they are what a teammate would search for.
 */
const PATH_SCAFFOLDING: ReadonlySet<string> = new Set([
  // Where code lives.
  "src",
  "lib",
  "libs",
  "test",
  "tests",
  "spec",
  "specs",
  "dist",
  "build",
  "out",
  "bin",
  "node",
  "modules",
  "packages",
  "package",
  "app",
  "apps",
  "index",
  // What type a file is.
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "md",
  "yml",
  "yaml",
  "toml",
  "lock",
  "txt",
  "sh",
  "sql",
  "css",
  "scss",
  "html",
  "py",
  "go",
  "rs",
  "rb",
  "php",
  "java",
  // Which LAYER of a program, never which program. `src` says where a file
  // sits in a build; these say where it sits in an architecture, and every
  // architecture has all of them — so a prompt naming one names nobody's
  // work. Measured in the golden corpus (11-generic-paths): before this
  // half of the list, "can you look at the routes", "add a types file",
  // "restart the services" and "who owns the handlers" each delivered a
  // teammate's evidence-backed root cause about a restock bug as substance,
  // four for four, because the words reached the document through a
  // DIRECTORY segment of src/routes/stock.ts and its siblings.
  "services",
  "service",
  "config",
  "configs",
  "types",
  "routes",
  "utils",
  "util",
  "helpers",
  "helper",
  "handlers",
  "handler",
  "components",
  "component",
  "middleware",
  "controllers",
  "controller",
  "common",
  "shared",
  "cmd",
  "pkg",
  "scripts",
  "assets",
  "static",
  "public",
  "vendor",
]);

/**
 * WHAT IS DELIBERATELY NOT ABOVE, because the line is meaning and not
 * frequency. `core`, `api`, `hooks`, `models`, `internal`, `db`, `auth` and
 * `views` are layer names in one repo and the subject itself in the next —
 * `hooks` is this product's whole Claude Code surface, `core` is half its
 * package names, and the golden corpus carries its domains in exactly such
 * directories (src/auth/refresh.ts, src/db/pool.ts, src/ws/reconnect.ts).
 *
 * Frequency cannot make that call, and was measured rather than assumed:
 * across nine unrelated repositories on this machine, `services` appears as a
 * directory segment in 4 and `auth` in 2 — the same order of magnitude — so a
 * threshold that drops the first keeps the second only by luck. What separates
 * them is that a reader who types `auth` is naming a subject and a reader who
 * types `services` is naming a shape, and only a human can write that down.
 *
 * The cost of being wrong here is asymmetric, which is why the list stays
 * short: a word wrongly dropped costs one lexical route to a context that is
 * still reachable by its title, its file names and its claims, while a word
 * wrongly kept injects a teammate's substance into an unrelated prompt.
 */

/** Everything that is not a letter or a digit separates two parts. */
const DELIMITER_PATTERN = /[^\p{L}\p{N}]+/u;

/**
 * The two CamelCase boundaries: lower-or-digit → upper (`selectHint`), and
 * upper → upper-lower (`XMLHttpRequest` → `XML` + `HttpRequest`). Written as
 * zero-width lookarounds so `split` returns the parts without consuming a
 * character of them.
 */
const CAMEL_BOUNDARY_PATTERN =
  /(?<=\p{Ll}|\p{N})(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/gu;

/**
 * Branch names that say nothing about what anybody is doing. `main` is not a
 * topic: every session that has not cut a branch yet sits on it, so indexing it
 * makes "rebase onto main" — a sentence a developer types several times a day —
 * a lexical match against every one of those sessions, and a lexical match is
 * what this product turns into a teammate hint (audit row M13). `master` is the
 * same branch under the older default and is here for the same reason.
 *
 * Consulted TWICE, because M13 has two doors and closing one left the other
 * open. `titleForDoc` below blanks a title that IS a default branch; this set
 * is also handed to the token bag, because the bag is built from the branch
 * name and from every target VALUE — and `cmd/main.go`, `src/main.rs` and
 * `app/src/main/java/…` are the ordinary shapes of three languages. On those
 * repos M13's own sentence matched again, through the path.
 *
 * Still a rule about a LABEL and never about the word: `the main loop
 * deadlocks` keeps its `main`, because the title is prose the human wrote and
 * the bag is only ever built from identifiers.
 */
const DEFAULT_BRANCH_LABELS: ReadonlySet<string> = new Set(["main", "master"]);

/**
 * The words inside one identifier, path or branch name — never the identifier
 * itself, which the caller already stores verbatim.
 */
const partsOf = (value: string): readonly string[] =>
  value
    .split(DELIMITER_PATTERN)
    .flatMap((chunk) => chunk.split(CAMEL_BOUNDARY_PATTERN))
    .filter(
      (part) =>
        part.length >= TOKEN_MIN_CHARS &&
        !PATH_SCAFFOLDING.has(part.toLowerCase()),
    );

/**
 * The deduplicated word bag for a set of values, as one line, bounded.
 *
 * `repoLabel` is dropped from the bag for the reason `titleForDoc` strips the
 * ` @ <repo>` suffix: it is this product's own label, every context on the
 * repo carries it, so it discriminates nothing while matching a query that
 * merely names the repo. The suffix strip is an EXACT match on the composed
 * title, so a repo whose name is also a directory in its own tree — `api`,
 * `server`, `web` — put the label straight back through any path crossing it
 * (`services/api/handler.ts`).
 *
 * DEDUPLICATED because the repetition is total: every path in a monorepo starts
 * `packages/<name>/src`, and a hundred of them would spend the whole bound on
 * three words. First-seen order, so the bag is deterministic and re-ingesting
 * unchanged rows produces a byte-identical document — which is what keeps the
 * embedding-invalidation WHERE clause in normalized-doc.ts honest.
 *
 * A value that is already one word contributes that word, which the document
 * carries verbatim anyway; the dedupe absorbs it.
 */
export const derivedTokenLine = (
  values: readonly string[],
  repoLabel: string | null,
): string => {
  const label = repoLabel?.toLowerCase() ?? null;
  const seen = new Set<string>();
  let line = "";
  for (const value of values) {
    for (const part of partsOf(value)) {
      const lowered = part.toLowerCase();
      if (seen.has(part) || lowered === label || DEFAULT_BRANCH_LABELS.has(lowered)) {
        continue;
      }
      seen.add(part);
      const candidate = line.length === 0 ? part : `${line} ${part}`;
      if (candidate.length > DERIVED_TOKENS_MAX_CHARS) {
        return line;
      }
      line = candidate;
    }
  }
  return line;
};

/**
 * The connector's own repo-label rule, restated on this side of the wire:
 * `github.com/acme/api` → `api`, and a `local:` id has no shareable segment at
 * all. It has to be restated because no import crosses this boundary — the
 * connector composes the title (connector-core flows/register-session.ts
 * `fallbackWorkContextTitle`) and the hub takes the label back off — so the two
 * spellings are pinned to each other rather than assumed equal:
 *
 * VERIFY: bun -e 'const a=await import("./packages/connector-core/src/flows/register-session.ts");const b=await import("./packages/server/src/services/search-tokens.ts");const ids=["github.com/acme/api","local:/tmp/x","gitlab.com/g/sub/repo"];console.log(ids.map((id)=>String(a.fallbackWorkContextTitle("feat/x",id)===(b.repoLabelOf(id)===null?"feat/x":"feat/x @ "+b.repoLabelOf(id)))).join(" "))'
 * PRINTS: true true true
 */
export const repoLabelOf = (repoId: string): string | null => {
  if (repoId.startsWith("local:")) {
    return null;
  }
  const last = repoId.split("/").at(-1)?.trim();
  return last === undefined || last.length === 0 ? null : last;
};

/**
 * The title as the FTS document may carry it: without the ` @ <repo>` suffix
 * the connector appends, and empty when nothing but a default-branch name is
 * left.
 *
 * The suffix is this product's own label rather than anybody's words — every
 * context on the repo carries it, so it discriminates nothing while matching a
 * query that merely names the repo. It is removed by exact match on the
 * composed form, so a title that CONTAINS the label somewhere else (inside a
 * path, inside a sentence) keeps it.
 */
export const titleForDoc = (
  title: string,
  repoLabel: string | null,
): string => {
  const suffix = repoLabel === null ? null : ` @ ${repoLabel}`;
  const stripped =
    suffix !== null && title.endsWith(suffix)
      ? title.slice(0, title.length - suffix.length)
      : title;
  const trimmed = stripped.trim();
  return DEFAULT_BRANCH_LABELS.has(trimmed.toLowerCase()) ? "" : trimmed;
};
