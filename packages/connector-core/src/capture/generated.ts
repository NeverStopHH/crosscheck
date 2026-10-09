/**
 * THE CONNECTOR HALF of the generated-target rule (@crosscheck/schema
 * generated-target.ts states the rule): is a captured file MECHANICALLY
 * GENERATED AND NON-AUTHORITATIVE — machine-written, and not a surface
 * anybody's plan stands on? ONE implementation for every connector — the
 * capture flow every host's edit and the git lane go through calls it
 * (flows/capture-targets.ts), and Claude's PreToolUse asks it before the
 * tripwire, so a path is classified the same way on Claude Code, Cursor and
 * every ACP agent.
 *
 * "MECHANICALLY GENERATED", CHEAPEST FIRST, each step only for the paths the
 * one before left open:
 *   1. path       a well-known name, no I/O at all (matchesGeneratedName) —
 *                 and a protobuf binding, but only when its `.proto` is in the
 *                 repo: ONE `git ls-files` per capture that holds a binding;
 *   2. attribute  one bounded `git check-attr` for the paths no cache entry
 *                 answers (capture/generated-attributes.ts);
 *   3. header     GENERATED_HEADER_BYTES of the file, reduced to a yes or no
 *                 here — the bytes never leave this function.
 *
 * "NON-AUTHORITATIVE" is the other half, and no signal is allowed to skip it.
 * A file that resembles a contract or a migration (isContractLike), or that
 * the repo's committed `authoritativeGenerated` names
 * (capture/authoritative-generated.ts), is `authoritative`: a signal fired,
 * and the file stays overlap evidence anyway. It travels with
 * `authoritative: true`, so the hub does not apply its own path signal to it.
 *
 * FIVE ANSWERS. `unknown` is a classification that could not run: git
 * missing, slow or not a repository, the file unreadable or gone. It is
 * counted — doctor prints it — and it is ORDINARY on the wire: no field is
 * sent, so the hub treats the target as overlap evidence. Failing toward a
 * warning is the only safe direction; an unknown that silenced would turn a
 * slow disk into a missed collision.
 */
import { open, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { matchesGeneratedName, protobufSourceOf } from "@crosscheck/schema";
import type { GeneratedSignal } from "@crosscheck/schema";

import { GENERATED_HEADER_BYTES, PROTOBUF_SOURCES_TIMEOUT_MS } from "../constants.ts";
import { runGitOutcome } from "../git/git.ts";
import { isAuthoritative, readAuthoritativeGenerated } from "./authoritative-generated.ts";
import type { AuthoritativeGenerated } from "./authoritative-generated.ts";
import { readAttributeSignals } from "./generated-attributes.ts";
import type { AttributeAnswer } from "./generated-attributes.ts";

export type GeneratedClassification = GeneratedSignal | "authoritative" | "unknown" | "ordinary";

/** How many captured targets each answer had — the counters doctor prints. */
export interface GeneratedTally {
  readonly path: number;
  readonly attribute: number;
  readonly header: number;
  /** A signal fired and the file counted anyway: declared, or a contract or migration. */
  readonly authoritative: number;
  readonly unknown: number;
}

export const NO_GENERATED: GeneratedTally = { path: 0, attribute: 0, header: 0, authoritative: 0, unknown: 0 };

/**
 * A comment leader at the start of a line, then the marker: `// @generated`,
 * ` * @generated`, `# @generated`, `-- Code generated … DO NOT EDIT.`. Anchored
 * on purpose — a file that merely MENTIONS the token in prose (this one, its
 * tests, a linter's docs) is somebody's hand-written code.
 */
const COMMENT_LEADER = String.raw`^[ \t]*(?:\/\/+|\/\*+|\*|#+|--|;+|<!--)[ \t]*`;
const GENERATED_TOKEN = new RegExp(`${COMMENT_LEADER}@generated\\b`, "m");
const CODE_GENERATED_LINE = new RegExp(`${COMMENT_LEADER}Code generated\\b.*\\bDO NOT EDIT\\.`, "m");

/** The header signal over text already read: pure, so it is testable alone. */
export const hasGeneratedHeader = (head: string): boolean =>
  GENERATED_TOKEN.test(head) || CODE_GENERATED_LINE.test(head);

/**
 * The first GENERATED_HEADER_BYTES of a regular file, judged; null when it
 * cannot be read. A non-regular path (a FIFO an open would block on, a
 * directory) is unreadable here, never waited on.
 */
const readHeaderSignal = async (root: string, path: string): Promise<boolean | null> => {
  const full = join(root, path);
  try {
    if (!(await stat(full)).isFile()) {
      return null;
    }
    const handle = await open(full, "r");
    try {
      const buffer = Buffer.alloc(GENERATED_HEADER_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, GENERATED_HEADER_BYTES, 0);
      return hasGeneratedHeader(buffer.subarray(0, bytesRead).toString("utf8"));
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
};

/**
 * The basenames of every tracked `.proto` under `root` — git's own pathspec
 * `*` crosses directories — or null when git did not answer. Read only for a
 * capture that holds a protobuf binding.
 */
const readProtoSources = async (root: string): Promise<ReadonlySet<string> | null> => {
  const outcome = await runGitOutcome(["ls-files", "-z", "--", "*.proto"], root, PROTOBUF_SOURCES_TIMEOUT_MS);
  if (!outcome.ok) {
    return null;
  }
  return new Set(
    outcome.stdout
      .split("\0")
      .filter((line) => line.length > 0)
      .map((line) => basename(line)),
  );
};

/** What each check said about one path. */
interface Evidence {
  /** A well-known generated name (no I/O). */
  readonly named: boolean;
  /** A binding whose `.proto` is in the repo; false = no binding or no source; null = git did not say. */
  readonly proto: boolean | null;
  readonly attribute: AttributeAnswer;
  readonly header: boolean | null;
}

/** A well-known name needs no other check, and gets none. */
const NAMED: Evidence = { named: true, proto: false, attribute: false, header: false };

const signalOf = (evidence: Evidence): GeneratedSignal | null => {
  if (evidence.named || evidence.proto === true) {
    return "path";
  }
  if (evidence.attribute === true) {
    return "attribute";
  }
  return evidence.header === true ? "header" : null;
};

/**
 * Positive evidence wins whichever check it came from — and loses to an
 * authoritative file, which stays evidence whatever fired. With no positive
 * evidence, a check that could not run makes the answer UNKNOWN: never a quiet
 * "ordinary" that reads as measured, and never generated.
 */
const decide = (evidence: Evidence, isAuthoritative: boolean): GeneratedClassification => {
  const signal = signalOf(evidence);
  if (signal !== null) {
    return isAuthoritative ? "authoritative" : signal;
  }
  const { attribute, header, proto } = evidence;
  return attribute === null || header === null || proto === null ? "unknown" : "ordinary";
};

export interface ClassifyGeneratedInput {
  readonly home: string;
  /** The worktree root the paths are relative to. */
  readonly root: string;
  /** Repo-relative paths under `root`, already through the denylist. */
  readonly paths: readonly string[];
  /** The attribute call's deadline; absent = GENERATED_ATTR_TIMEOUT_MS. */
  readonly attrTimeoutMs?: number;
  /** `root`'s declaration, when the caller already read it; absent = read here. */
  readonly authoritative?: AuthoritativeGenerated;
  /** Neighbours the attribute call may answer for the cache too (generated-attributes.ts). */
  readonly prefetch?: readonly string[];
}

export const classifyGenerated = async (
  input: ClassifyGeneratedInput,
): Promise<ReadonlyMap<string, GeneratedClassification>> => {
  const declared = input.authoritative ?? (await readAuthoritativeGenerated(input.root));
  const unnamed = input.paths.filter((path) => !matchesGeneratedName(path));
  const holdsBinding = unnamed.some((path) => protobufSourceOf(path) !== null);
  const [attributes, protoSources] = await Promise.all([
    readAttributeSignals({
      home: input.home,
      root: input.root,
      paths: unnamed,
      ...(input.attrTimeoutMs === undefined ? {} : { timeoutMs: input.attrTimeoutMs }),
      ...(input.prefetch === undefined ? {} : { prefetch: input.prefetch.filter((path) => !matchesGeneratedName(path)) }),
    }),
    holdsBinding ? readProtoSources(input.root) : Promise.resolve(new Set<string>()),
  ]);
  const gathered = await Promise.all(
    unnamed.map(async (path): Promise<readonly [string, Evidence]> => {
      const attribute = attributes.get(path) ?? null;
      const source = protobufSourceOf(path);
      const proto = source === null ? false : protoSources === null ? null : protoSources.has(source);
      // The header is read only where nothing cheaper already answered.
      const header = attribute === true || proto === true ? false : await readHeaderSignal(input.root, path);
      return [path, { named: false, proto, attribute, header }];
    }),
  );
  const evidence = new Map(gathered);
  return new Map(
    input.paths.map((path) => [
      path,
      decide(evidence.get(path) ?? NAMED, isAuthoritative(path, declared)),
    ]),
  );
};

/** The signal a target carries on the wire: only a positive one; unknown is ordinary. */
export const wireGeneratedSignal = (
  classification: GeneratedClassification | undefined,
): GeneratedSignal | undefined =>
  classification === "path" || classification === "attribute" || classification === "header"
    ? classification
    : undefined;

/** Folds classifications into the counters doctor reads. */
export const tallyGenerated = (
  classifications: Iterable<GeneratedClassification>,
): GeneratedTally => {
  let tally = NO_GENERATED;
  for (const classification of classifications) {
    tally = classification === "ordinary" ? tally : { ...tally, [classification]: tally[classification] + 1 };
  }
  return tally;
};

export const addGeneratedTally = (left: GeneratedTally, right: GeneratedTally): GeneratedTally => ({
  path: left.path + right.path,
  attribute: left.attribute + right.attribute,
  header: left.header + right.header,
  authoritative: left.authoritative + right.authoritative,
  unknown: left.unknown + right.unknown,
});
