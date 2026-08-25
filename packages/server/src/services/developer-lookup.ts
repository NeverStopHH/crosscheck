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
 * so.
 *
 * THREE CALLERS, and that is the whole point: `GET /api/search` (R1),
 * `POST /api/questions` (R2) and the two mute routes. The mute routes used to
 * answer an ambiguous name with "several developers share that name — use
 * their email or id", which names NOBODY — a reader who knew the address would
 * not have typed the name — and R2 would have made that a third spelling of
 * one refusal. They all say the same two sentences now
 * (routes/settings.ts `failForResolution`), so being refused once is enough to
 * know exactly what to retype.
 */
import { asc } from "drizzle-orm";

import { developers } from "../db/schema.ts";
import { asRendered, fitRefusal, MAX_REFUSAL_CHARS } from "./refusal.ts";
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
      /** Every developer of that name, not just the page above. */
      readonly totalCount: number;
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
    return {
      outcome: "ambiguous",
      candidates: resolved.candidates,
      totalCount: resolved.totalCount,
    };
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
 * was allowed and gets dropped from the list for it. `asRendered` first,
 * because the unit those characters are counted in is the reader's, and a
 * display name is untrusted text that may be four times longer once the
 * connector normalizes it (services/refusal.ts says what that costs). */
const shortened = (value: string, maxChars: number): string => {
  const rendered = asRendered(value);
  return rendered.length <= maxChars
    ? rendered
    : `${rendered.slice(0, Math.max(0, maxChars - 1))}…`;
};

/**
 * As many of them as `maxChars` holds, then the true count of the rest.
 * Budgeted in CHARACTERS rather than in people, because a display name and an
 * email address have no length in common; the COUNT is never abbreviated, so a
 * list cut short still tells the reader how many there really are.
 *
 * `maxChars` comes from `fitRefusal`, which knows what the sentence around it
 * has left — the list is the last thing asked to give up room, and the first
 * thing a reader needs.
 *
 * `total` IS NOT `values.length` WHEREVER THE VALUES ARE A PAGE. That promise
 * one paragraph up was broken the moment a caller handed in the five rows an
 * ambiguity probe read: the "and N more" was then counted from the page, so a
 * hub with twelve Kims said five and offered two more. Callers whose values
 * really are the whole set leave it out.
 */
const listAndCount = (
  values: readonly string[],
  maxChars: number,
  total: number = values.length,
): { readonly text: string; readonly shown: number } => {
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
  const rest = total - shown.length;
  const listed = shown.join(", ");
  if (rest <= 0) {
    return { text: listed, shown: shown.length };
  }
  return {
    text:
      shown.length === 0
        ? `${String(rest)} of them, none short enough to name here`
        : `${listed} and ${String(rest)} more`,
    shown: shown.length,
  };
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
/**
 * Why guessing is worse — true, worth saying, and the FIRST thing worth
 * dropping when the sentence is short of room, because a reader holding an
 * exact address does not need to be told why they should not guess.
 */
const AMBIGUITY_WHY = "; a guess would credit the wrong person";

export const describeAmbiguousDeveloper = (
  term: string,
  candidates: readonly DeveloperCandidate[],
  totalCount: number,
): string => {
  // Normalized, never cut: an address is for RETYPING, and the form the reader
  // can retype is the one their connector renders.
  const addresses = candidates.map((person) => asRendered(person.email));
  const sentence = (echo: string, list: string, why: string): string =>
    `${echo} is the name of ${String(totalCount)} developers here: ${list}. ` +
    `Ask again with the exact address${why}.`;
  /**
   * ONE WHOLE ADDRESS, OR THE SENTENCE HAS NO NEXT ACTION AT ALL. Budgeted
   * normally, a list of addresses all longer than `listChars` shows none of
   * them and falls back to "N of them, none short enough to name here" —
   * beside "Ask again with the exact address", which is the same dead end
   * e541ed0 closed for names and left standing here.
   *
   * So the yield order gains a middle step. The echo still gives up characters
   * first; then the RATIONALE clause is spent, which buys 38 characters — more
   * than enough for a corporate address; only then does the list give up room.
   * `mayPay` false is the last resort for an address longer than the whole
   * budget, where naming it would push the sentence past the cap a connector
   * quotes and the reader would lose the next step as well as the address.
   */
  const build =
    (mayPay: boolean) =>
    (echo: string, listChars: number): string => {
      const budgeted = listAndCount(addresses, listChars, totalCount);
      if (budgeted.shown > 0 || !mayPay) {
        return sentence(echo, budgeted.text, AMBIGUITY_WHY);
      }
      const first = addresses[0] ?? "";
      return sentence(
        echo,
        listAndCount(addresses, first.length, totalCount).text,
        "",
      );
    };
  const naming = fitRefusal(build(true), term);
  return asRendered(naming).length <= MAX_REFUSAL_CHARS
    ? naming
    : fitRefusal(build(false), term);
};

export const describeUnknownDeveloper = (
  term: string,
  suggestions: readonly DeveloperCandidate[],
): string =>
  fitRefusal(
    (echo, listChars) =>
      `${echo} matches no developer on this hub, so nothing was searched. Closest ` +
      `known names: ${
        listAndCount(
          suggestions.map((person) =>
            // Shortened to whatever the sentence has left, never to nothing: a
            // list that names one recognisable spelling beats a list that names
            // a count, and the reader retypes a name rather than copying it.
            shortened(person.name, Math.min(MAX_LISTED_NAME_CHARS, listChars)),
          ),
          listChars,
          // No page here: DEVELOPER_SUGGESTION_LIMIT spellings is the whole
          // offer, so the count and the values are about the same set.
        ).text
      }. Ask again with a name or address the hub knows.`,
    term,
  );
