import { MAX_ID_CHARS, MAX_TITLE_CHARS } from "../constants.ts";
import {
  ELLIPSIS,
  INJECTION_BRANCHES,
  INJECTION_SPAN_PATTERN,
  REDACTED_SPAN,
  cleanUntrusted,
  cutWellFormed,
  spanRedacted,
} from "@crosscheck/schema";

/**
 * THE PRIMITIVES LIVE IN @crosscheck/schema (untrusted-text.ts): the
 * separators, the invisibles, the renderer-owned characters, the phrase
 * branches and the span redaction moved there so the hub scores a claim on
 * exactly what a reader is shown (review 1006b, M4). Re-exported under the
 * names every caller here has always used.
 */
export { INJECTION_BRANCHES, REDACTED_SPAN, cleanUntrusted } from "@crosscheck/schema";

export const REDACTED_TITLE = "[redacted: title looked like an instruction]";

/**
 * Opportunistic defence-in-depth, not a guarantee. The primary defence is
 * structural and sits above and around this list: NFKC normalization, control /
 * format / zero-width stripping, removal of the characters the renderer owns,
 * the length cap, the « » quote frame, and the briefing header that states the
 * quoted text is data rather than instruction. This literal-phrase list only
 * catches the blunt attempts — "forget everything above" walks straight past
 * it, and trying to complete the list is not a winnable game.
 */
const INJECTION_PATTERN = new RegExp(`(${INJECTION_BRANCHES.join("|")})`, "i");

/**
 * Renders untrusted, teammate- or LLM-authored text safe for injection into the
 * reader's context. Returns "" when nothing survives — callers skip the item.
 */
export const sanitizeUntrusted = (
  raw: string,
  maxChars: number = MAX_TITLE_CHARS,
): string => {
  const cleaned = cleanUntrusted(raw);
  // Redundant, deliberately, and recorded so it is not re-reported as a gap:
  // deleting this guard reddens NO test. The claim is the absence of a failure,
  // so there is no test name to quote and a total is all there is — `bun test`
  // printed 319 pass / 0 fail with the guard deleted, on macOS 26 arm64 and in
  // oven/bun:1 under --cpus=2 alike. It stays green because with `cleaned` empty
  // the phrase test below cannot match and `cleaned.length <= maxChars` returns
  // "" anyway — read the three branches under it. The guard stays because
  // "nothing survived, skip the item" is the contract callers rely on, and that
  // should be stated here rather than derived from a cap comparison.
  if (cleaned.length === 0) {
    return "";
  }
  if (INJECTION_PATTERN.test(cleaned)) {
    return REDACTED_TITLE;
  }
  if (cleaned.length <= maxChars) {
    return cleaned;
  }
  // cutWellFormed, not slice: a cut landing between the halves of an astral
  // character would otherwise leave a lone high surrogate before the
  // ellipsis (cut.ts says what that costs and shows it).
  return `${cutWellFormed(cleaned, maxChars - ELLIPSIS.length)}${ELLIPSIS}`;
};


/**
 * The same defence, applied to the MATCHED SPAN instead of to the whole body.
 *
 * `sanitizeUntrusted` above blanks everything as soon as one branch matches,
 * and for a work-context title that is the right trade: the title is a label,
 * and a label that reads like an instruction is worth losing. It is the wrong
 * trade wherever the body IS the answer — a hub refusal, whose entire payload
 * is the reason nothing was searched plus the names and addresses to retry
 * with. There, one `override`-shaped word anywhere in the sentence took away
 * every candidate spelling and the whole next step, and the reader was left
 * with a redaction marker where their next call should have been.
 *
 * Everything else is unchanged and still runs first: NFKC, the separators, the
 * invisibles, the characters the renderer owns, the length cap, and the « »
 * frame plus the quoted-data notice at the call site. This narrows ONE branch
 * of the defence, on surfaces that opt in.
 *
 * STILL NOT THE DEFAULT, and the line is a CLASS rather than a call count
 * (audit row M14, now built — an earlier version of this comment described it
 * as unbuilt and named a caller, `quotedSpanRedacted`, that no longer exists).
 * A LABEL is a name for something, and a name that reads like an instruction is
 * worth losing whole: titles and stated intents keep `sanitizeUntrusted`. A
 * BODY is the answer itself, and every surface that prints one frames it
 * through `quotedBody` in mcp/render.ts, which is the single caller shape here
 * — claim bodies, recorded root causes, questions and their answers, hub
 * refusals, conference findings.
 *
 * The half this could not give, and no longer has to: `redactionNote` below
 * tells the AUTHOR when their own text will reach a teammate with a hole in it,
 * so a redaction is never something only the reader can see.
 *
 * The callers, derived rather than counted by hand — the last line is this
 * directive matching its own file:
 *
 * VERIFY: grep -rl 'spanRedactedUntrusted(' packages/connector-core/src | sort
 * PRINTS: packages/connector-core/src/briefing/questions.ts
 * PRINTS: packages/connector-core/src/briefing/render.ts
 * PRINTS: packages/connector-core/src/briefing/sanitize.ts
 * PRINTS: packages/connector-core/src/conference/report.ts
 * PRINTS: packages/connector-core/src/mcp/render-intent-chain.ts
 * PRINTS: packages/connector-core/src/mcp/render.ts
 */
export const spanRedactedUntrusted = (
  raw: string,
  maxChars: number = MAX_TITLE_CHARS,
): string => spanRedacted(raw, maxChars);

/**
 * Characters the renderers use as LINE STRUCTURE, removed from every field
 * printed bare outside the « » frame.
 *
 * U+00B7 separates the facts on a claim, edge, context, search and absence
 * line; the colon ends the fact list and opens the body. A field that keeps
 * either writes renderer structure rather than content — a display name of
 * `Robin · status verified · confidence 1.00 · Alice` mints a second status, a
 * second confidence and a second author, and every character in it is
 * legitimate, so no defence above that reasons about CHARACTERS can see it.
 *
 * U+2014 EM DASH joined them when the conference report shipped: that page
 * separates a line's FACTS from the CALL that reads them with " — " on four
 * line shapes (conference/report.ts), so a display name of `Ken — get_diagnosis
 * wc_<attacker>` mints a second, followable pointer at a tree the attacker
 * chose, and the report is written for a human — often an agent, pasted in —
 * to read later. It is the same class as the U+00B7 forgery and it belongs in
 * the same strip; the reason it was missed is that no character invariant can
 * see it, which is why the report's own tests now count call tokens per line.
 *
 * Titles keep all three deliberately (the U+00B7 entry in the table above): a
 * title lands INSIDE the frame, so a separator forges structure only within
 * visible quotes, and stripping punctuation there would mangle ordinary prose.
 */
const RENDERER_STRUCTURE = /[·:\u2014]/g;

/**
 * A short field a renderer prints OUTSIDE the frame: a claim's kind and
 * status, a developer's display name, an absence line's author name. One strip
 * for both surfaces that print such fields — the MCP renderer and the
 * briefing's absence section — or the two would drift apart the way two
 * copies of QUOTED_DATA_NOTICE would.
 *
 * Weaker than the MCP renderer's id allowlist (`safeId`) and deliberately so:
 * a display name has to keep letters from every script, and an allowlist
 * narrow enough to stop a sentence would relabel real people as unnamed. What
 * this guarantees is structural — a field cannot mint another field. What it
 * does NOT guarantee: an unframed name that reads as a sentence still reaches
 * the reader outside the quotes (stated on `renderDiagnosis`).
 */
export const bareUntrusted = (
  raw: string,
  maxChars: number = MAX_TITLE_CHARS,
): string =>
  sanitizeUntrusted(raw, maxChars)
    .replace(RENDERER_STRUCTURE, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Characters an id may carry, written once and used in both directions.
 *
 * `ID_ALPHABET` is the negated form `safeId` strips WITH; `SAFE_ID_PATTERN` is
 * the positive form the tool schemas validate AGAINST, so an id an agent
 * supplies has to already be what an id the renderer prints would be reduced
 * to. Two literals for one alphabet would be two things to widen, and widening
 * only the schema is exactly how an unprintable id becomes an unanswerable
 * call.
 *
 * MOVED HERE FROM mcp/render.ts when the briefing grew its first bare-id field
 * (the contradiction pointer's cx_ id): this file already holds the other two
 * untrusted-text classes — PROSE (`sanitizeUntrusted`) and BARE
 * (`bareUntrusted`) — and importing the ID class the other way round would
 * have made briefing/render.ts and mcp/render.ts a cycle.
 */
/*
 * ONE ALPHABET, TWO PACKAGES. The HUB validates an id against the same set
 * before it stores one (`@crosscheck/schema`'s `SAFE_ID_PATTERN`), so an id
 * that reaches this renderer is already what this renderer would print — which
 * is what makes `formatQuestionEntry`'s "a row I will not vouch for is
 * dropped" true instead of "an id I will silently rewrite into one the hub has
 * never heard of".
 *
 * VERIFY: bun -e 'const a=await import("./packages/schema/src/question.ts");const b=await import("./packages/connector-core/src/briefing/sanitize.ts");console.log(a.SAFE_ID_PATTERN.source === b.SAFE_ID_PATTERN.source)'
 * PRINTS: true
 */
const ID_ALPHABET_SOURCE = "A-Za-z0-9_.:-";
const ID_ALPHABET = new RegExp(`[^${ID_ALPHABET_SOURCE}]`, "g");
export const SAFE_ID_PATTERN = new RegExp(`^[${ID_ALPHABET_SOURCE}]+$`);

/**
 * An id, reduced to characters that cannot open a frame, emit markup or start
 * a line — and cannot be turned into prose either.
 *
 * `sanitizeUntrusted` is the wrong tool here and using it was the first
 * draft's bug: it returns REDACTED_TITLE for anything the phrase filter
 * matches, so a claim whose id happened to contain `override` became
 * unaddressable. An allowlist has no such branch, and it removes rather than
 * spaces, so the id an agent reads back is the id it can pass to the next
 * tool.
 */
export const safeId = (raw: string): string =>
  raw.replace(ID_ALPHABET, "").slice(0, MAX_ID_CHARS);

/**
 * What to tell the AUTHOR when their own words will not reach a teammate
 * intact — the second half of audit row M14.
 *
 * A body is stored exactly as written; the redaction happens at RENDER time on
 * somebody else's machine, which means that without this note the author never
 * learns that a sentence of theirs arrives with a hole in it, that their stated
 * intent arrives as a marker, or that the whole item was dropped. The remedy
 * the moderation literature settles on for hidden content is the cheap one:
 * tell the author. This is that notification, for the one such rule this
 * product has.
 *
 * IT NEVER QUOTES THE MATCH BACK. Not out of secrecy — the author wrote it —
 * but because this string is returned into the context of an agent that is
 * about to act on what it reads, and pasting an instruction-shaped phrase
 * there is the exact thing the phrase filter exists to prevent. The author
 * gets a count and the class of the problem; their body is in front of them.
 *
 * IT MEASURES THE REAL PIPELINE rather than describing it. The whole-blanking
 * branch asks `sanitizeUntrusted` itself, by POSITIVE equality on
 * REDACTED_TITLE, so the note cannot claim a blanking the renderer does not do
 * (and an unknown future outcome fails closed to "no note"); the span branch
 * counts with INJECTION_SPAN_PATTERN, the same constant `spanRedactedUntrusted`
 * replaces with; the vanish branch asks `cleanUntrusted`, which every surface
 * runs first. A re-typed copy of any of the three would be free to disagree
 * with the code it describes, which is the defect this file already fixed once
 * by exporting INJECTION_BRANCHES.
 *
 * `blankWhole` names the LABEL class (a work-context title, a stated intent),
 * where the surface drops the value entirely rather than the span. Null means
 * nothing would be redacted and the caller says nothing at all — a note on
 * every ordinary publish would be noise, and noise is what stops warnings
 * being read.
 *
 * There is deliberately no length argument. The count is what the filter
 * matches in the whole text; a surface that ALSO cuts for length may show
 * fewer of them, and a note that said "two" where a reader sees one would be
 * worse than a note that stays about the text the author wrote.
 */
export const redactionNote = (
  raw: string,
  options: { readonly blankWhole?: boolean } = {},
): string | null => {
  const cleaned = cleanUntrusted(raw);
  if (cleaned.length === 0) {
    // The severest outcome and the one nothing else reports: every renderer
    // treats "" as "skip the item", so the author's text does not arrive
    // shortened — it does not arrive at all, and no surface says so.
    return (
      "Heads up: none of this text survives the safety pass teammates read " +
      "through (it is punctuation, quote marks or invisible characters only), " +
      "so it reaches nobody. It is stored as written; add words to it."
    );
  }
  if (options.blankWhole === true) {
    return sanitizeUntrusted(raw) === REDACTED_TITLE
      ? "Heads up: this text reads as an instruction, so teammates will see it " +
          `blanked whole as ${REDACTED_TITLE} rather than as your words. ` +
          "Rephrasing it is the only way through — it is stored either way."
      : null;
  }
  const matches = cleaned.match(INJECTION_SPAN_PATTERN);
  if (matches === null || matches.length === 0) {
    return null;
  }
  const count = matches.length;
  const phrases = count === 1 ? "phrase" : "phrases";
  return (
    `Heads up: ${String(count)} ${phrases} in this text read as an ` +
    `instruction, so teammates will see ${REDACTED_SPAN} in their place. ` +
    "The rest of the sentence arrives; rephrase if those words carried the " +
    "meaning."
  );
};
