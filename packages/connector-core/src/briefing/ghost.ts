/**
 * The ONE spelling of a ghost check (VISION.md §3) — the briefing's
 * "Teammates working on the same things right now" block and, through the
 * same formatter, the sentence `set_intent` returns the moment a plan is
 * declared. Two spellings of this line would be two places for the pointer
 * discipline to slip.
 *
 * IT IS A POINTER AND IT NEVER BLOCKS. What the line asserts is arithmetic —
 * this many of YOUR OWN values also sit on somebody else's live context, and
 * this many words of YOUR OWN intent appear in their doc. It asserts no
 * cause, quotes no claim, and asks for no decision; `get_diagnosis <id>`
 * is one call away for anybody who wants the substance. That is what keeps
 * ghost checks inside DESIGN.md §4 while a teammate's evidence-backed root
 * cause needs both evidence and identity before it may be quoted at all.
 *
 * WHY IT NAMES YOUR FILES BACK AT YOU. Every value here is one the reader's
 * own session already captured — the hub only ever sends the intersection —
 * so the line discloses nothing about the teammate's file list, and the paths
 * it prints are the ones the reader recognises. A shared error fingerprint is
 * named as a FACT and never as a hash: "hit the same failure" is what a tired
 * human can act on, and 39 characters of sha256 on a briefing line is not.
 *
 * A render-layer module, registered in RENDER_LAYER_MODULES beside intent.ts,
 * questions.ts and render.ts, and covered by the §4.4 hostile corpus through
 * its own surface.
 */
import {
  AGE_HOURS_BEFORE_DAYS,
  GHOST_SHARED_VALUE_MAX_CHARS,
  MAX_TITLE_CHARS,
  MINUTES_PER_HOUR,
  MS_PER_SECOND,
  SECONDS_PER_MINUTE,
} from "../constants.ts";
import type { GhostCheckEntry } from "../http/hub.ts";
import { bareUntrusted, safeId, sanitizeUntrusted } from "./sanitize.ts";
import { renderIntent } from "./intent.ts";

/** The teammate name a row that carries none falls back to. */
const UNKNOWN_TEAMMATE = "a teammate";

/**
 * The kind the line reports as a shared FAILURE rather than as a value. The
 * hub sorts the bounded sample by kind ascending and "error_fingerprint"
 * sorts first, so this test on the sample is equivalent to a test on the
 * whole overlap (http/hub.ts GhostCheckEntrySchema states the contract).
 */
const FINGERPRINT_KIND = "error_fingerprint";

const ageMsFrom = (iso: string, now: Date): number | null => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : now.getTime() - ms;
};

/**
 * A LIVE age, in the shortest true unit. Deliberately not briefing/render's
 * `formatAge`: importing it would make render.ts and this module a cycle
 * (render.ts imports this one), the same reason the id alphabet moved into
 * sanitize.ts. Days are the coarsest unit any ghost row can reach —
 * GHOST_ACTIVE_WINDOW_DAYS is one week — so there is no months branch to
 * keep in step with anything.
 */
export const formatGhostAge = (ageMs: number): string => {
  const seconds = Math.max(0, Math.floor(ageMs / MS_PER_SECOND));
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < MINUTES_PER_HOUR) {
    return `${String(minutes)}m ago`;
  }
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  return hours < AGE_HOURS_BEFORE_DAYS
    ? `${String(hours)}h ago`
    : `${String(Math.floor(hours / 24))}d ago`;
};

/**
 * The overlap clauses, strongest first — a shared failure, then the shared
 * values by name, then the shared topic. Empty means this row has no reason
 * a reader could check, and the caller drops it rather than printing a name
 * with no "why": a warning nobody can evaluate is the prediction theatre
 * this feature was built to avoid.
 */
const overlapClauses = (entry: GhostCheckEntry): readonly string[] => {
  const sample = entry.sharedTargets;
  const failure = sample.some((target) => target.kind === FINGERPRINT_KIND)
    ? ["hit the same failure"]
    : [];
  const named = sample
    .filter((target) => target.kind !== FINGERPRINT_KIND)
    .map((target) => bareUntrusted(target.value, GHOST_SHARED_VALUE_MAX_CHARS))
    .filter((value) => value.length > 0);
  // The remainder is stated rather than implied: the hub bounds the sample,
  // and "also on a.ts, b.ts" beside an overlap of nine would be true about
  // the two and false about the size of the collision.
  const hidden = Math.max(0, entry.sharedTargetCount - sample.length);
  const more = hidden === 0 ? "" : ` (+${String(hidden)} more of yours)`;
  const values = named.length === 0 ? [] : [`also on ${named.join(", ")}${more}`];
  // Any positive count is already above the hub's floor (http/hub.ts), so no
  // copy of that constant lives here.
  const topic = entry.intentTokenHits > 0 ? ["same topic as your intent"] : [];
  return [...failure, ...values, ...topic];
};

/**
 * WHAT THEY SAY THEY ARE DOING, and it is the one framed value on the line:
 * their intent if they stated or derived one, else their work-context title.
 * Exactly one « » pair either way — the invariant every briefing line holds —
 * and null when neither survives the sanitizer, which costs the line its plan
 * clause and nothing else.
 */
const planFragment = (entry: GhostCheckEntry): string | null => {
  const intent = renderIntent(entry.intent);
  if (intent !== null) {
    return intent;
  }
  const title = sanitizeUntrusted(entry.title, MAX_TITLE_CHARS);
  return title.length === 0 ? null : `titled «${title}»`;
};

/**
 * One ghost check as the single line every surface prints. Null = a row this
 * renderer will not vouch for: an id outside the allowlist, an unparseable
 * timestamp, or no checkable reason at all.
 */
export const formatGhostLine = (
  entry: GhostCheckEntry,
  now: Date,
): string | null => {
  const id = safeId(entry.workContextId);
  const ageMs = ageMsFrom(entry.lastActiveAt, now);
  const clauses = overlapClauses(entry);
  if (id.length === 0 || ageMs === null || clauses.length === 0) {
    return null;
  }
  const name =
    entry.developerName === undefined ? "" : bareUntrusted(entry.developerName);
  const who = name.length === 0 ? UNKNOWN_TEAMMATE : name;
  const plan = planFragment(entry);
  // U+00B7-separated facts, the shape of every other teammate line here — the
  // structure the BARE class strips from names and values, so neither can
  // mint a field of its own.
  return [
    `- ${who}`,
    `last active ${formatGhostAge(ageMs)}`,
    ...clauses,
    ...(plan === null ? [] : [plan]),
    `get_diagnosis ${id}`,
  ].join(" · ");
};
