/**
 * A developer filter that does not resolve must FAIL, in words, never quietly
 * return nothing.
 *
 * An empty result to `developer: "Kenn"` reads as "Ken has done nothing" —
 * the most expensive false statement a discovery tool can make, because the
 * reader acts on it by redoing Ken's work. So the two miss paths get sentences
 * instead of an empty list: ambiguity names the candidates with their
 * addresses (Gerrit refuses an ambiguous account for the same reason), and an
 * unknown name offers the closest spellings the hub knows.
 *
 * The RESOLUTION rule itself is not here — it lives once, in
 * services/developer-settings.ts, shared with the mute surfaces. This module
 * adds only what a refusal needs: which known names are close, and how to say
 * so. Both halves are shared with the question channel, so a name that
 * searches is a name you can ask with, and both surfaces refuse identically.
 */
import { asc } from "drizzle-orm";

import { developers } from "../db/schema.ts";
import { resolveDeveloperRef } from "./developer-settings.ts";
import type { DeveloperCandidate } from "./developer-settings.ts";
import type { MuteEntryView } from "./developer-settings.ts";
import type { Db } from "../db/client.ts";

/**
 * Longest accepted developer reference (id, email or display name). Shared
 * with the mute routes, which had it first: one bound for one concept, so a
 * name that is too long to mute cannot be a name that is short enough to
 * filter by.
 */
export const MAX_DEVELOPER_REF_CHARS = 320;

/** Most spellings an unknown-name refusal offers. */
export const DEVELOPER_SUGGESTION_LIMIT = 3;

/**
 * Rows the suggestion pass reads. Bounded like every hub listing, with
 * `developers_name_idx` behind the ORDER BY; a hub is one team, so the bound
 * sits far above any real membership. Past it a closer spelling can be missed
 * — which is why the sentence says the term matched nobody (true whatever the
 * scan saw) and offers the closest it KNOWS, rather than claiming the person
 * does not exist.
 */
export const DEVELOPER_SUGGESTION_SCAN = 500;

/** How much of the caller's own term is echoed back in a refusal. */
const MAX_ECHOED_TERM_CHARS = 80;

export type DeveloperLookup =
  | { readonly outcome: "resolved"; readonly developer: MuteEntryView }
  | {
      readonly outcome: "ambiguous";
      readonly candidates: readonly DeveloperCandidate[];
    }
  | {
      readonly outcome: "unknown";
      readonly suggestions: readonly DeveloperCandidate[];
    };

/** Character bigrams — the unit the closeness score is counted in. */
const bigrams = (value: string): ReadonlySet<string> => {
  const pairs = new Set<string>();
  for (let index = 0; index + 1 < value.length; index += 1) {
    pairs.add(value.slice(index, index + 2));
  }
  return pairs;
};

/**
 * Sørensen–Dice over character bigrams, with containment ranked above it.
 *
 * Deliberately dumb and dependency-free: this decides which THREE names a
 * refusal offers, never which rows come back, so "roughly right" is the whole
 * requirement. A typo that merely ADDS or DROPS characters — "kenn", "ke" —
 * is containment and scores 0.9 without the bigram pass ever running; a
 * genuinely different word falls through to Dice and scores near zero.
 *
 * VERIFY: bun -e 'const m=await import("./packages/server/src/services/developer-lookup.ts");console.log(m.spellingCloseness("kenn","ken").toFixed(1), m.spellingCloseness("kem","ken").toFixed(1), m.spellingCloseness("kenn","nick").toFixed(1))'
 * PRINTS: 0.9 0.5 0.0
 */
export const spellingCloseness = (term: string, candidate: string): number => {
  if (term === candidate) {
    return 1;
  }
  if (
    term.length > 0 &&
    candidate.length > 0 &&
    (candidate.includes(term) || term.includes(candidate))
  ) {
    return 0.9;
  }
  const left = bigrams(term);
  const right = bigrams(candidate);
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  const shared = [...left].filter((pair) => right.has(pair)).length;
  return (2 * shared) / (left.size + right.size);
};

/** Name and the local part of the address — both are things people type. */
const scoreOf = (term: string, developer: DeveloperCandidate): number =>
  Math.max(
    spellingCloseness(term, developer.name.toLowerCase()),
    spellingCloseness(term, developer.email.toLowerCase().split("@")[0] ?? ""),
  );

const suggestSpellings = async (
  db: Db,
  term: string,
): Promise<readonly DeveloperCandidate[]> => {
  const known = await db
    .select({
      id: developers.id,
      name: developers.name,
      email: developers.email,
    })
    .from(developers)
    .orderBy(asc(developers.name), asc(developers.email))
    .limit(DEVELOPER_SUGGESTION_SCAN);
  const lowered = term.trim().toLowerCase();
  // New array, scored once per row; ties broken by name so one hub gives one
  // sentence however the rows arrived.
  return [...known]
    .map((developer) => ({ developer, score: scoreOf(lowered, developer) }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.developer.name.localeCompare(right.developer.name),
    )
    .slice(0, DEVELOPER_SUGGESTION_LIMIT)
    .map((scored) => scored.developer);
};

/**
 * One developer, or the reason there is not exactly one — with everything the
 * refusal will need already gathered. The suggestion scan runs ONLY on the
 * miss path, so the hot case (a name that resolves) stays the two indexed
 * point lookups resolveDeveloperRef already did.
 */
export const lookUpDeveloper = async (
  db: Db,
  term: string,
): Promise<DeveloperLookup> => {
  const resolved = await resolveDeveloperRef(db, term);
  if (resolved.outcome === "resolved") {
    return resolved;
  }
  if (resolved.outcome === "ambiguous") {
    return { outcome: "ambiguous", candidates: resolved.candidates };
  }
  return { outcome: "unknown", suggestions: await suggestSpellings(db, term) };
};

const echoTerm = (term: string): string =>
  `"${term.trim().slice(0, MAX_ECHOED_TERM_CHARS)}"`;

const listPeople = (people: readonly DeveloperCandidate[]): string =>
  people.map((person) => `${person.name} (${person.email})`).join(", ");

/**
 * The refusals, in words a tired human reads at 23:00: what was asked for,
 * what this hub knows, and the exact next call. They live beside the lookup
 * because every surface that resolves a teammate refuses for the same two
 * reasons and must say the same thing.
 *
 * The term is the caller's own text handed back to the caller; every
 * connector frames a hub message as quoted data before a model sees it
 * (mcp/tools/shared.ts).
 */
export const describeAmbiguousDeveloper = (
  term: string,
  candidates: readonly DeveloperCandidate[],
): string =>
  `${echoTerm(term)} is the name of ${String(candidates.length)} developers on this hub: ` +
  `${listPeople(candidates)}. Nothing was searched, because picking one of them would have ` +
  "attributed the wrong person's work. Ask again with one of those email addresses.";

export const describeUnknownDeveloper = (
  term: string,
  suggestions: readonly DeveloperCandidate[],
): string =>
  `${echoTerm(term)} matches no developer on this hub, so nothing was searched — this is ` +
  "not a result about anyone's work. Known developers with the closest spelling: " +
  `${listPeople(suggestions)}. Ask again with a name or email address exactly as it appears there.`;
