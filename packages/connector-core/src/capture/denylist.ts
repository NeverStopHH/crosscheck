/**
 * Hot-file denylist (DESIGN.md §4): lockfiles, build output and generated
 * clients drown real overlap signal, so they never become targets.
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
  "**/generated/**",
  "**/*.gen.*",
  "**/*.generated.*",
  "**/*.pb.go",
  "**/*_pb2.py",
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
