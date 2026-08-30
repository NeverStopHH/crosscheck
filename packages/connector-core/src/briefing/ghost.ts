/**
 * The ONE spelling of a ghost check (VISION.md §3) — the briefing's
 * "Teammates working where you are" block and, through the
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
  HOURS_PER_DAY,
  MAX_GHOST_POINTERS,
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
    : `${String(Math.floor(hours / HOURS_PER_DAY))}d ago`;
};

/**
 * The overlap clauses, strongest first — a shared failure, then the shared
 * values by name, then how many words of the reader's own intent matched. Empty means this row has no reason
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
  // "shares", not "also on": "also" wants an antecedent, and on a row with no
  // failure clause before it there is none.
  const values = named.length === 0 ? [] : [`shares ${named.join(", ")}${more}`];
  // THE COUNT, not "same topic as your intent". Any positive value is already
  // above the hub's floor (http/hub.ts), so no copy of that constant lives
  // here — but the number itself is on the wire and throwing it away made
  // this the one clause a reader cannot check, on the tier with the weakest
  // evidence behind it. Its neighbours name theirs ("hit the same failure",
  // "shares a.ts, b.ts"); DESIGN.md §10 risk 8 promises a COUNT rule the
  // reader can check against the line, and "three words of your intent" is
  // that promise kept.
  const hits = entry.intentTokenHits;
  const words =
    hits > 0 ? [`${String(hits)} word${hits === 1 ? "" : "s"} of your intent`] : [];
  return [...failure, ...values, ...words];
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
 * The teammate as the BARE field every ghost surface prints, or the honest
 * fallback. ONE spelling: the line and the stored attribution both name the
 * same person the same way, and a sanitizer that has to be remembered twice
 * is a sanitizer that will be dropped once.
 */
const teammateName = (entry: GhostCheckEntry): string => {
  const name =
    entry.developerName === undefined ? "" : bareUntrusted(entry.developerName);
  return name.length === 0 ? UNKNOWN_TEAMMATE : name;
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
  const who = teammateName(entry);
  const plan = planFragment(entry);
  // U+00B7-separated facts, the shape of every other teammate line here — the
  // structure the BARE class strips from names and values, so neither can
  // mint a field of its own.
  return [
    `- ${who}`,
    // THEIR plan next to THEM. `intentFragment` is deliberately
    // possessive-free (briefing/intent.ts keeps one spelling for every
    // surface), so what binds the bare `intent:` label to a person is
    // POSITION — and after a clause containing the words "your intent" the
    // nearest preceding noun was the reader, so the teammate's sentence read
    // as the reader's own echoed back and got skipped. It is the one clause
    // on the line worth reading.
    ...(plan === null ? [] : [plan]),
    `last active ${formatGhostAge(ageMs)}`,
    ...clauses,
    `get_diagnosis ${id}`,
  ].join(" · ");
};

/**
 * WHOSE plan the row is about, as a clause a stored sentence can carry.
 *
 * The gated half's answer (connector-claude ghost/worker.ts) becomes a DRAFT
 * on the reader's own context, and the model is never told who the other
 * session belongs to — it is shown "SESSION B" precisely so it cannot invent
 * anything about a named person. So the name is attached HERE, deterministically,
 * from the same row the deterministic half returned: without it the reader
 * opens `review_draft` on a sentence about a collision with nobody, and has
 * neither a tree to read nor a person to ask.
 *
 * Sanitized like the line above it — BARE name — because it comes from the
 * hub, and this string is stored rather than only printed.
 */
export const ghostAttribution = (entry: GhostCheckEntry): string =>
  `${teammateName(entry)}'s live plan`;

/**
 * The ghost DRAFT body: WHOSE plan it collides with, then the model's one
 * sentence, then the tree. The composition lives beside the line rather than
 * in the worker so a ghost check reads the same way wherever it is met, and
 * so the untrusted halves go through the same two sanitizers in both places.
 *
 * THE PERSON LEADS, and that is a measurement rather than a preference. The
 * only surface a ghost draft is ever met on is the briefing's own-drafts
 * block, whose `formatDraftLine` cuts a body at MAX_TITLE_CHARS = 80 — while
 * the sentence itself may be GHOST_SENTENCE_MAX_CHARS = 200. With the
 * attribution appended, every sentence over 73 characters rendered as a
 * truncated hypothesis and a `review_draft` id with no teammate and no tree
 * on the line at all: the reader could not open it and could not tell who to
 * ask, which is the failure the attribution was added to remove. Leading with
 * it makes the name survive the cut for every sentence length there is.
 *
 * The sentence itself is NOT sanitized here and must not be: it is this
 * machine's own model output, already bounded, echo-checked and secret-scanned
 * by the worker, and it is framed by `formatDraftLine` when it is shown —
 * the summarizer's drafts travel exactly this way.
 *
 * The worst case a body can reach — the longest sentence this writer allows,
 * beside a name and an id longer than either sanitizer will pass — still fits
 * the claim the hub will store. Composed through this function rather than
 * added up from literals, so a wording change here re-runs the arithmetic:
 *
 * VERIFY: bun -e 'const g=await import("./packages/connector-core/src/briefing/ghost.ts");const c=await import("./packages/connector-core/src/constants.ts");const s=await import("./packages/schema/src/index.ts");console.log(g.ghostDraftBody("x".repeat(c.GHOST_SENTENCE_MAX_CHARS),{workContextId:"w".repeat(400),title:"t",developerId:"d",developerName:"N".repeat(400),intent:null,lastActiveAt:"",sharedTargets:[],sharedTargetCount:0,intentTokenHits:0}).length <= s.MAX_CLAIM_BODY_LENGTH)'
 * PRINTS: true
 */
export const ghostDraftBody = (
  sentence: string,
  entry: GhostCheckEntry,
): string => {
  const id = safeId(entry.workContextId);
  const collision = `${ghostAttribution(entry)} collides: ${sentence}`;
  return id.length === 0 ? collision : `${collision} — get_diagnosis ${id}`;
};

/**
 * The one header both surfaces print. The briefing composes it into a
 * `Section` and `set_intent` prints it as a block; a second literal would be
 * a second place for "nothing here blocks you" to be dropped, which is the
 * half of the sentence that keeps this feature advisory.
 *
 * IT CLAIMS NO TENSE ITS OWN LINES CANNOT KEEP. It used to say "right now"
 * over a window of GHOST_ACTIVE_WINDOW_DAYS = 7, so the header sat directly
 * above lines reading "last active 6d ago" — and a reader who takes that at
 * face value, pings a teammate about a file they last touched last week and
 * learns the block overstates is a reader who stops reading the block. Each
 * line carries its own age; the header states WHERE, and lets the age say
 * WHEN.
 *
 * IT NAMES BOTH TOOLS, in the house shape the questions block uses
 * ("answer_question replies"). A collision is something the reader is
 * expected to ACT on — by opening a tree or by talking to the person — and
 * `get_diagnosis` alone answers only the first half. `ask_teammate` takes
 * exactly the two things a ghost line already hands over, the teammate and
 * their work-context id, so the one action that settles "are we about to undo
 * each other's work" stops being undiscoverable from the block that raised
 * the question.
 */
export const GHOST_SECTION_HEADER =
  "Teammates working where you are " +
  "(get_diagnosis reads their tree, ask_teammate asks them; " +
  "nothing here blocks you):";

export interface GhostNotice {
  /** The block, or "" when no row survived — callers print nothing then. */
  readonly text: string;
  /** Lines actually shown, for the counter the reader's own state keeps. */
  readonly shown: number;
}

/**
 * The ghost block as `set_intent` returns it, bounded in ITEMS exactly as the
 * briefing bounds its section — and deliberately not in CHARACTERS, which is
 * the one place the two surfaces differ.
 *
 * The briefing spends a shared 2200-character budget that eight sections
 * compete for, so its ghost block carries a second bound
 * (MAX_BRIEFING_GHOST_CHARS, applied in briefing/render.ts) and the sections
 * below it are what a long ghost row would otherwise cost. A tool answer
 * competes with nothing: it is read once, by the agent that just declared the
 * plan, in reply to a call it made itself. Dropping a row here would hide a
 * collision to save characters nobody else needs.
 *
 * No "+N more" tail either, for the same reason: a count of rows this answer
 * cannot reach would be noise rather than a next action.
 */
export const renderGhostNotice = (
  entries: readonly GhostCheckEntry[],
  now: Date,
): GhostNotice => {
  const lines = entries
    .flatMap((entry) => {
      const line = formatGhostLine(entry, now);
      return line === null ? [] : [line];
    })
    .slice(0, MAX_GHOST_POINTERS);
  return lines.length === 0
    ? { text: "", shown: 0 }
    : { text: [GHOST_SECTION_HEADER, ...lines].join("\n"), shown: lines.length };
};
