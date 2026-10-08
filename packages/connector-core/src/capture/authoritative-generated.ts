/**
 * `authoritativeGenerated` — A REPO'S OWN WORD that some generated files are
 * AUTHORITATIVE and stay overlap evidence: a checked-in API schema, generated
 * migrations, client bindings two pieces of work both stand on. Declared in
 * the committed `.crosscheck.json` as repo-relative globs:
 *
 *   { "hubUrl": "…", "authoritativeGenerated": ["api/openapi.json", "migrations/**", "clients/**"] }
 *
 * A matching file is never suppressed by the generated-target rule, whichever
 * signal fires (capture/generated.ts), and it passes the denylist's
 * generated-output entries — lockfiles, `dist/`, `*.generated.*` — but no
 * other (capture/denylist.ts isDeniedUnlessAuthoritative).
 *
 * THE TRUST RULE FOR `.crosscheck.json` HOLDS (DESIGN.md §2.1):
 *   - read from ONE place: the `.crosscheck.json` at the root of the worktree
 *     the touched file lives in — the committed file that makes that root
 *     reportable at all. Never from the environment, never from the home;
 *   - parsed apart from the hub URL. A malformed list costs the list, never
 *     the repo: config/repo-config.ts does not read this field, so no value
 *     here can make a connected repo silent;
 *   - it can only UN-suppress. A forged or careless list makes crosscheck warn
 *     about more files, never about fewer — fail toward warning, the one
 *     safe direction;
 *   - it is BOUNDED (constants.ts MAX_AUTHORITATIVE_GENERATED_GLOBS and the
 *     per-glob caps), and every entry is validated: repo-relative, no `..`,
 *     no backslash or control character, a bounded number of wildcards. An
 *     entry refused or past the cap is counted and named by `doctor`, never
 *     silently dropped.
 */
import { join } from "node:path";
import { isContractLike } from "@crosscheck/schema";

import {
  MAX_AUTHORITATIVE_GENERATED_GLOBS,
  MAX_AUTHORITATIVE_GLOB_CHARS,
  MAX_AUTHORITATIVE_GLOB_WILDCARDS,
  REPO_CONFIG_FILE,
} from "../constants.ts";
import { readJsonOrNull } from "../config/paths.ts";
import { matchesGlob } from "./denylist.ts";

/** The field's name in `.crosscheck.json`. */
export const AUTHORITATIVE_GENERATED_FIELD = "authoritativeGenerated";

export interface RefusedGlob {
  /** The entry as written, cut to MAX_AUTHORITATIVE_GLOB_CHARS for display. */
  readonly glob: string;
  readonly reason: string;
}

export interface AuthoritativeGenerated {
  /** Whether the file declares the field at all. */
  readonly declared: boolean;
  /** The valid globs, in file order, at most MAX_AUTHORITATIVE_GENERATED_GLOBS. */
  readonly globs: readonly string[];
  /** Entries refused, with the reason — doctor prints them. */
  readonly refused: readonly RefusedGlob[];
  /** Valid entries past the cap, ignored. */
  readonly overCap: number;
}

export const NO_AUTHORITATIVE_GENERATED: AuthoritativeGenerated = {
  declared: false,
  globs: [],
  refused: [],
  overCap: 0,
};

const CONTROL_OR_BACKSLASH = /[\p{Cc}\\]/u;
const WILDCARD = /[*?]/g;

/** Why this entry cannot be a repo-relative glob, or null when it can. */
const globProblem = (entry: unknown): string | null => {
  if (typeof entry !== "string") {
    return "not a string";
  }
  if (entry.trim().length === 0) {
    return "empty";
  }
  if (entry.length > MAX_AUTHORITATIVE_GLOB_CHARS) {
    return `longer than ${String(MAX_AUTHORITATIVE_GLOB_CHARS)} characters`;
  }
  if (entry.startsWith("/")) {
    return "absolute — globs are repo-relative";
  }
  if (entry.split("/").includes("..")) {
    return "climbs out of the repo with ..";
  }
  if (CONTROL_OR_BACKSLASH.test(entry)) {
    return "contains a backslash or a control character";
  }
  if ((entry.match(WILDCARD) ?? []).length > MAX_AUTHORITATIVE_GLOB_WILDCARDS) {
    return `more than ${String(MAX_AUTHORITATIVE_GLOB_WILDCARDS)} wildcards`;
  }
  return null;
};

/** An entry as doctor may name it: never more than MAX_AUTHORITATIVE_GLOB_CHARS. */
const shown = (entry: unknown): string =>
  (typeof entry === "string" ? entry : String(JSON.stringify(entry))).slice(0, MAX_AUTHORITATIVE_GLOB_CHARS);

/** The field out of an already-parsed `.crosscheck.json`, validated and bounded. */
export const parseAuthoritativeGenerated = (config: unknown): AuthoritativeGenerated => {
  if (typeof config !== "object" || config === null || !(AUTHORITATIVE_GENERATED_FIELD in config)) {
    return NO_AUTHORITATIVE_GENERATED;
  }
  const raw = (config as Record<string, unknown>)[AUTHORITATIVE_GENERATED_FIELD];
  if (!Array.isArray(raw)) {
    return { ...NO_AUTHORITATIVE_GENERATED, declared: true, refused: [{ glob: shown(raw), reason: "not a list of globs" }] };
  }
  const refused: RefusedGlob[] = [];
  const valid: string[] = [];
  for (const entry of raw as readonly unknown[]) {
    const problem = globProblem(entry);
    if (problem === null) {
      valid.push(entry as string);
    } else {
      refused.push({ glob: shown(entry), reason: problem });
    }
  }
  return {
    declared: true,
    globs: valid.slice(0, MAX_AUTHORITATIVE_GENERATED_GLOBS),
    refused,
    overCap: Math.max(0, valid.length - MAX_AUTHORITATIVE_GENERATED_GLOBS),
  };
};

/**
 * The declaration at `root`'s `.crosscheck.json`. An absent, unreadable or
 * unparseable file declares nothing — every generated file keeps its default.
 */
export const readAuthoritativeGenerated = async (root: string): Promise<AuthoritativeGenerated> =>
  parseAuthoritativeGenerated(await readJsonOrNull(join(root, REPO_CONFIG_FILE)));

/** Does the repo's declaration name this repo-relative path? */
export const isDeclaredAuthoritative = (path: string, declared: AuthoritativeGenerated): boolean =>
  declared.globs.some((glob) => matchesGlob(glob, path));

/**
 * IS THIS FILE AUTHORITATIVE — overlap evidence even when a generated-target
 * signal fires? The repo declared it, or it resembles a contract or a
 * migration (@crosscheck/schema isContractLike). ONE predicate for every
 * place a default would suppress: the classifier (capture/generated.ts), the
 * denylist's generated-output entries (flows/capture-targets.ts, Claude's
 * PreToolUse). A schema `*.generated.*` dropped by the denylist is the same
 * silence as one the classifier labels, so both ask this.
 */
export const isAuthoritative = (path: string, declared: AuthoritativeGenerated): boolean =>
  isContractLike(path) || isDeclaredAuthoritative(path, declared);
