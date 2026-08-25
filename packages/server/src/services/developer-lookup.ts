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
import { fitRefusal } from "./refusal.ts";
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

/**
 * Longest a single NAME may be before it is shown cut. Addresses are never
 * cut, and the difference is the same one that decides which of the two each
 * refusal lists: a name is for RECOGNITION — "oh, Ken Weber" — and survives
 * losing its tail, while an address is for RETYPING and a cut one is simply a
 * different, wrong address. Without this an org whose display names carry
 * titles gets "3 of them, none short enough to name here", which names nobody
 * and leaves the reader with no next step at all.
 */
const MAX_LISTED_NAME_CHARS = 40;

/** At most `maxChars` characters, ellipsis included — the caller budgets in
 * the units it counts in, so a shortened value never costs one more than it
 * was allowed and gets dropped from the list for it. */
const shortened = (value: string, maxChars: number): string =>
  value.length <= maxChars
    ? value
    : `${value.slice(0, Math.max(0, maxChars - 1))}…`;

/**
 * As many of them as `maxChars` holds, then the true count of the rest.
 * Budgeted in CHARACTERS rather than in people, because a display name and an
 * email address have no length in common; the COUNT is never abbreviated, so a
 * list cut short still tells the reader how many there really are.
 *
 * `maxChars` comes from `fitRefusal`, which knows what the sentence around it
 * has left — the list is the last thing asked to give up room, and the first
 * thing a reader needs.
 */
const listAndCount = (
  values: readonly string[],
  maxChars: number,
): string => {
  const shown: string[] = [];
  let used = 0;
  for (const value of values) {
    const cost = used === 0 ? value.length : value.length + 2;
    if (used + cost > maxChars) {
      break;
    }
    shown.push(value);
    used += cost;
  }
  const rest = values.length - shown.length;
  const listed = shown.join(", ");
  if (rest === 0) {
    return listed;
  }
  return shown.length === 0
    ? `${String(rest)} of them, none short enough to name here`
    : `${listed} and ${String(rest)} more`;
};

/**
 * The refusals, in words a tired human reads at 23:00: what was asked for,
 * what this hub knows, and the exact next call. They live beside the lookup
 * because every surface that resolves a teammate refuses for the same two
 * reasons and must say the same thing.
 *
 * WHAT EACH ONE LISTS is decided by what the reader has to retype. Same-named
 * candidates differ only by ADDRESS, so ambiguity lists addresses, whole; a
 * misspelt name is fixed by the NAME, so the suggestions list names, shortened
 * rather than dropped. Neither repeats "nothing was searched" beyond once —
 * the connector's own line says it too.
 *
 * BOTH GO THROUGH `fitRefusal`, which is not decoration: the term is the
 * caller's, its length is the caller's choice, and a sentence whose actionable
 * half falls past MAX_REFUSAL_CHARS is quoted away by every connector. The
 * echo gives up characters first; the addresses and the spellings never do.
 *
 * The term is the caller's own text handed back to the caller; every connector
 * frames a hub message as quoted data before a model sees it
 * (mcp/tools/shared.ts).
 */
export const describeAmbiguousDeveloper = (
  term: string,
  candidates: readonly DeveloperCandidate[],
): string =>
  fitRefusal(
    (echo, listChars) =>
      `${echo} is the name of ${String(candidates.length)} developers here: ` +
      `${listAndCount(
        candidates.map((person) => person.email),
        listChars,
      )}. Ask again with the exact address; a guess would credit the wrong person.`,
    term,
  );

export const describeUnknownDeveloper = (
  term: string,
  suggestions: readonly DeveloperCandidate[],
): string =>
  fitRefusal(
    (echo, listChars) =>
      `${echo} matches no developer on this hub, so nothing was searched. Closest ` +
      `known names: ${listAndCount(
        suggestions.map((person) =>
          // Shortened to whatever the sentence has left, never to nothing: a
          // list that names one recognisable spelling beats a list that names
          // a count, and the reader retypes a name rather than copying it.
          shortened(person.name, Math.min(MAX_LISTED_NAME_CHARS, listChars)),
        ),
        listChars,
      )}. Ask again with a name or address the hub knows.`,
    term,
  );
