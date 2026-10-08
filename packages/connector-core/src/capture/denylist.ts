/**
 * Hot-file denylist (DESIGN.md §4): lockfiles, build output, dependencies,
 * binaries and secrets drown real overlap signal, so they never become
 * targets.
 *
 * NOT `generated/`, `*.gen.*`, `*.pb.go` or `*_pb2.py` any more: each can be
 * hand-maintained or authoritative (a hand-kept `generated/` directory, a
 * generator's own `*.gen.*` input, a protobuf binding vendored without its
 * `.proto`), and a drop here is final — the touch never exists. The
 * generated-target rule decides those instead (capture/generated.ts), where a
 * mechanically generated, non-authoritative file is KEPT and labelled and a
 * repo can say otherwise.
 */
export const DEFAULT_DENYLIST: readonly string[] = [
  "**/*.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "go.sum",
  "Gemfile.lock",
  "Cargo.lock",
  "poetry.lock",
  "composer.lock",
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/.next/**",
  "**/target/**",
  "**/coverage/**",
  "**/__pycache__/**",
  "**/.venv/**",
  "**/vendor/**",
  "**/*.generated.*",
  "**/*.min.js",
  "**/*.map",
  "**/*.snap",
  "**/.env*",
  "**/*.pem",
  "**/*.key",
  "**/*.{png,jpg,jpeg,gif,pdf,zip,parquet,mp4,woff,woff2}",
];

export type DenylistMode = "extend" | "replace";

export interface DenylistConfig {
  readonly mode: DenylistMode;
  readonly patterns: readonly string[];
}

const escapeLiteral = (char: string): string =>
  /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;

const compileBraceGroup = (
  pattern: string,
  start: number,
): { readonly source: string; readonly next: number } | null => {
  const end = pattern.indexOf("}", start);
  if (end === -1) {
    return null;
  }
  const alternatives = pattern
    .slice(start + 1, end)
    .split(",")
    .map((alternative) => [...alternative].map(escapeLiteral).join(""));
  return { source: `(?:${alternatives.join("|")})`, next: end + 1 };
};

/** Supports `*`, `**`, `?` and `{a,b}` against a POSIX repo-relative path. */
const globToRegExp = (pattern: string): RegExp => {
  let source = "";
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index] as string;
    if (char === "*") {
      const isDoubleStar = pattern[index + 1] === "*";
      if (isDoubleStar) {
        const isSegmentWildcard = pattern[index + 2] === "/";
        source += isSegmentWildcard ? "(?:.*/)?" : ".*";
        index += isSegmentWildcard ? 3 : 2;
        continue;
      }
      source += "[^/]*";
      index += 1;
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      index += 1;
      continue;
    }
    if (char === "{") {
      const group = compileBraceGroup(pattern, index);
      if (group !== null) {
        source += group.source;
        index = group.next;
        continue;
      }
    }
    source += escapeLiteral(char);
    index += 1;
  }
  return new RegExp(`^${source}$`);
};

const REGEX_CACHE = new Map<string, RegExp>();

const cachedRegExp = (pattern: string): RegExp => {
  const cached = REGEX_CACHE.get(pattern);
  if (cached !== undefined) {
    return cached;
  }
  const compiled = globToRegExp(pattern);
  REGEX_CACHE.set(pattern, compiled);
  return compiled;
};

export const matchesGlob = (pattern: string, path: string): boolean =>
  cachedRegExp(pattern).test(path);

/** `extend` appends to the defaults; `replace` swaps them out entirely. */
export const resolveDenylist = (config?: DenylistConfig): readonly string[] => {
  if (config === undefined) {
    return DEFAULT_DENYLIST;
  }
  return config.mode === "replace"
    ? config.patterns
    : [...DEFAULT_DENYLIST, ...config.patterns];
};

export const isDenied = (
  relativePath: string,
  patterns: readonly string[],
): boolean => patterns.some((pattern) => matchesGlob(pattern, relativePath));

/**
 * The shipped entries that drop MECHANICALLY GENERATED OUTPUT a repo may
 * commit and own — lockfiles, `dist/`, `*.generated.*`: the same files the
 * generated-target rule names. A path the repo declares authoritative
 * (`authoritativeGenerated`, capture/authoritative-generated.ts) passes THESE
 * and nothing else: dependencies, caches, binaries and secret-bearing files
 * stay dropped whatever a committed file says.
 */
export const GENERATED_OUTPUT_PATTERNS: ReadonlySet<string> = new Set([
  "**/*.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "go.sum",
  "Gemfile.lock",
  "Cargo.lock",
  "poetry.lock",
  "composer.lock",
  "**/dist/**",
  "**/*.generated.*",
]);

/**
 * `isDenied`, except that a path the repo declared authoritative passes when
 * EVERY pattern that drops it is a generated-output one: `clients/dist/api.js`
 * declared authoritative is captured, `clients/node_modules/x/dist/y.js` is
 * not — `node_modules` still drops it.
 */
export const isDeniedUnlessAuthoritative = (
  relativePath: string,
  patterns: readonly string[],
  isAuthoritative: boolean,
): boolean => {
  const dropping = patterns.filter((pattern) => matchesGlob(pattern, relativePath));
  if (dropping.length === 0) {
    return false;
  }
  return !(isAuthoritative && dropping.every((pattern) => GENERATED_OUTPUT_PATTERNS.has(pattern)));
};
