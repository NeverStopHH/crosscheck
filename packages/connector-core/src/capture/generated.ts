/**
 * THE CONNECTOR HALF of the generated-target rule (@crosscheck/schema
 * generated-target.ts states the rule): which signal, if any, says a captured
 * file is machine-written. ONE implementation for every connector — the
 * capture flow every host's edit and the git lane go through calls it
 * (flows/capture-targets.ts), and Claude's PreToolUse asks it before the
 * tripwire, so a path is classified the same way on Claude Code, Cursor and
 * every ACP agent.
 *
 * CHEAPEST FIRST, and each step only for the paths the one before left open:
 *   1. path       no I/O at all (isGeneratedPath);
 *   2. attribute  one bounded `git check-attr` for the paths no cache entry
 *                 answers (capture/generated-attributes.ts);
 *   3. header     GENERATED_HEADER_BYTES of the file, reduced to a yes or no
 *                 here — the bytes never leave this function.
 *
 * FOUR ANSWERS, NOT THREE. `unknown` is a classification that could not run:
 * git missing, slow or not a repository, the file unreadable or gone. It is
 * counted — doctor prints it — and it is ORDINARY on the wire: no field is
 * sent, so the hub treats the target as overlap evidence. Failing toward a
 * warning is the only safe direction; an unknown that silenced would turn a
 * slow disk into a missed collision.
 */
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { isGeneratedPath } from "@crosscheck/schema";
import type { GeneratedSignal } from "@crosscheck/schema";

import { GENERATED_HEADER_BYTES } from "../constants.ts";
import { readAttributeSignals } from "./generated-attributes.ts";
import type { AttributeAnswer } from "./generated-attributes.ts";

export type GeneratedClassification = GeneratedSignal | "unknown" | "ordinary";

/** How many captured targets each answer had — the counters doctor prints. */
export interface GeneratedTally {
  readonly path: number;
  readonly attribute: number;
  readonly header: number;
  readonly unknown: number;
}

export const NO_GENERATED: GeneratedTally = { path: 0, attribute: 0, header: 0, unknown: 0 };

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
 * Positive evidence wins whichever check it came from; with none, a check
 * that could not run makes the answer UNKNOWN — never a quiet "ordinary" that
 * reads as measured, and never generated.
 */
const decide = (attribute: AttributeAnswer, header: boolean | null): GeneratedClassification => {
  if (attribute === true) {
    return "attribute";
  }
  if (header === true) {
    return "header";
  }
  return attribute === null || header === null ? "unknown" : "ordinary";
};

export interface ClassifyGeneratedInput {
  readonly home: string;
  /** The worktree root the paths are relative to. */
  readonly root: string;
  /** Repo-relative paths under `root`, already through the denylist. */
  readonly paths: readonly string[];
  /** The attribute call's deadline; absent = GENERATED_ATTR_TIMEOUT_MS. */
  readonly attrTimeoutMs?: number;
}

export const classifyGenerated = async (
  input: ClassifyGeneratedInput,
): Promise<ReadonlyMap<string, GeneratedClassification>> => {
  const unnamed = input.paths.filter((path) => !isGeneratedPath(path));
  const attributes = await readAttributeSignals({
    home: input.home,
    root: input.root,
    paths: unnamed,
    ...(input.attrTimeoutMs === undefined ? {} : { timeoutMs: input.attrTimeoutMs }),
  });
  const decided = await Promise.all(
    unnamed.map(async (path): Promise<readonly [string, GeneratedClassification]> => {
      const attribute = attributes.get(path) ?? null;
      // The header is read only where the attribute did not already answer.
      const header = attribute === true ? false : await readHeaderSignal(input.root, path);
      return [path, decide(attribute, header)];
    }),
  );
  const answers = new Map(decided);
  return new Map(
    input.paths.map((path) => [path, answers.get(path) ?? "path"]),
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
  unknown: left.unknown + right.unknown,
});
