/**
 * The ATTRIBUTE signal of the generated-target rule: is `linguist-generated`
 * or `linguist-vendored` set on this path — the attributes GitHub itself reads
 * to fold a file out of a diff — answered by `git check-attr`, ONE bounded call
 * per capture for the paths no cache entry answers.
 *
 * CACHED PER WORKTREE ROOT, KEYED BY THE ROOT `.gitattributes` BLOB ID. Each
 * hook is its own process, so an in-memory answer dies with the call; the
 * cache file is what makes "never on the hot path more than once per path"
 * true across PreToolUse, PostToolUse and the next session. The key is the id
 * git would give the root file (`blob <len>\0<bytes>`, hashed here — reading
 * it from git would cost the spawn the cache exists to save), taken from the
 * WORKING TREE rather than HEAD because the working tree is what `check-attr`
 * reads: a key from HEAD would keep answers an uncommitted edit already made
 * wrong. What the key does NOT cover, stated: a nested `.gitattributes` and
 * `.git/info/attributes`. A change to those alone is seen once the root file
 * changes or the entry ages out of the bound.
 *
 * THREE-VALUED, and the third value is the point: `null` means git did not
 * answer (no binary, not a repo, the deadline) and is NEVER cached — the next
 * capture asks again — and the classifier turns it into UNKNOWN, which keeps
 * the target ordinary.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import {
  GENERATED_ATTR_TIMEOUT_MS,
  MAX_GENERATED_ATTRIBUTE_CACHE_ENTRIES,
} from "../constants.ts";
import { generatedAttributesCachePath, readJsonOrNull, writePrivateFile } from "../config/paths.ts";
import { runGitOutcome } from "../git/git.ts";

/** true = generated or vendored, false = neither, null = git could not say. */
export type AttributeAnswer = boolean | null;

const ATTRIBUTES = ["linguist-generated", "linguist-vendored"] as const;

/** `attr` alone prints `set`; `attr=true` prints `true`. `unset`, `false` and `unspecified` are no. */
const SET_VALUES: ReadonlySet<string> = new Set(["set", "true"]);

/** The key of a root with no `.gitattributes` at all: every answer is a plain "no". */
const ABSENT_KEY = "absent";

const CACHE_VERSION = 1;

const AttributeCacheSchema = z.object({
  version: z.literal(CACHE_VERSION),
  key: z.string().min(1),
  entries: z.array(z.tuple([z.string().min(1), z.boolean()])),
});

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

/**
 * The root `.gitattributes` blob id, ABSENT_KEY without one, or null when the
 * file exists and cannot be read — then no answer is cached or trusted from
 * the cache, and check-attr is simply asked.
 */
const attributesKey = async (root: string): Promise<string | null> => {
  try {
    const bytes = await readFile(join(root, ".gitattributes"));
    return new Bun.CryptoHasher("sha1")
      .update(`blob ${String(bytes.byteLength)}\0`)
      .update(bytes)
      .digest("hex");
  } catch (error) {
    return isMissing(error) ? ABSENT_KEY : null;
  }
};

const readCache = async (
  home: string,
  root: string,
  key: string,
): Promise<ReadonlyMap<string, boolean>> => {
  const parsed = AttributeCacheSchema.safeParse(
    await readJsonOrNull(generatedAttributesCachePath(home, root)),
  );
  // Another key is another `.gitattributes`: every answer under it is stale.
  return parsed.success && parsed.data.key === key ? new Map(parsed.data.entries) : new Map();
};

/**
 * Newest last, bounded: an entry asked again moves to the end, and past
 * MAX_GENERATED_ATTRIBUTE_CACHE_ENTRIES the oldest go.
 */
const writeCache = async (
  home: string,
  root: string,
  key: string,
  cached: ReadonlyMap<string, boolean>,
  answered: ReadonlyMap<string, boolean>,
): Promise<void> => {
  const merged = [
    ...[...cached].filter(([path]) => !answered.has(path)),
    ...answered,
  ].slice(-MAX_GENERATED_ATTRIBUTE_CACHE_ENTRIES);
  try {
    await writePrivateFile(
      generatedAttributesCachePath(home, root),
      `${JSON.stringify({ version: CACHE_VERSION, key, entries: merged })}\n`,
    );
  } catch {
    // A cache that cannot be written is a repeat `check-attr` next time and
    // nothing else: the answer this call needed is already in hand.
  }
};

/**
 * `git check-attr -z` prints `<path>\0<attribute>\0<value>\0` per path and
 * attribute. A path git did not echo back gets no answer — UNKNOWN to the
 * caller — rather than a guessed "no".
 */
const parseCheckAttr = (stdout: string): ReadonlyMap<string, boolean> => {
  const fields = stdout.split("\0");
  const answers = new Map<string, boolean>();
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const path = fields[index] as string;
    const value = fields[index + 2] as string;
    answers.set(path, (answers.get(path) ?? false) || SET_VALUES.has(value));
  }
  return answers;
};

const askGit = async (
  root: string,
  paths: readonly string[],
  timeoutMs: number,
): Promise<ReadonlyMap<string, boolean> | null> => {
  const outcome = await runGitOutcome(
    ["check-attr", "-z", ...ATTRIBUTES, "--", ...paths],
    root,
    timeoutMs,
  );
  return outcome.ok ? parseCheckAttr(outcome.stdout) : null;
};

export interface AttributeSignalsInput {
  readonly home: string;
  /** The worktree root the paths are relative to — where git is asked. */
  readonly root: string;
  readonly paths: readonly string[];
  /** Absent = GENERATED_ATTR_TIMEOUT_MS. Tests pass a deadline git cannot meet. */
  readonly timeoutMs?: number;
}

/** Each path's answer: the cache's when it has one, else git's, else null. */
export const readAttributeSignals = async (
  input: AttributeSignalsInput,
): Promise<ReadonlyMap<string, AttributeAnswer>> => {
  if (input.paths.length === 0) {
    return new Map();
  }
  const key = await attributesKey(input.root);
  const cached = key === null ? new Map<string, boolean>() : await readCache(input.home, input.root, key);
  const misses = input.paths.filter((path) => !cached.has(path));
  const answered =
    misses.length === 0
      ? new Map<string, boolean>()
      : await askGit(input.root, misses, input.timeoutMs ?? GENERATED_ATTR_TIMEOUT_MS);
  if (key !== null && answered !== null && answered.size > 0) {
    await writeCache(input.home, input.root, key, cached, answered);
  }
  return new Map(
    input.paths.map((path) => [path, cached.get(path) ?? answered?.get(path) ?? null]),
  );
};
