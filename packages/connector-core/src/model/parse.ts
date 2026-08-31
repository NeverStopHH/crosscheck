/**
 * Tolerant parsing of a model's stdout (DESIGN.md §3 Tier 1), in core so
 * every connector's worker parses the same way: the contract is
 * "schema-validated claim JSON or the literal NONE", and ANYTHING else is
 * discarded — a draft is a bonus, never worth an error surface.
 *
 * TOLERANT OF WHAT, EXACTLY. The prompts were tuned on a Haiku-class Claude,
 * but CROSSCHECK_SUMMARIZER_CMD has always let an operator put a DIFFERENT
 * model behind the same contract (runner.ts), and a foreign model wraps its
 * answer in habits of its own. Three of those habits were measured against
 * this parser on 2026-08-28 and each one was handled WRONG, so the shapes
 * below are now stripped before anything is judged:
 *
 *   REASONING BLOCKS. A model that thinks out loud in `<think>…</think>`
 *   before answering used to have its SCRATCHPAD parsed as the answer: the
 *   brace hunt ran from the first `{` anywhere in stdout, so
 *   `<think>a candidate would be {"kind":"decision",…,"confidence":0.9} but
 *   the slice has no conclusion</think>\nNONE` filed a teammate-visible draft
 *   built out of the text the model had just REJECTED. That is the worst
 *   defect this file has ever had — a fabricated conclusion, from an answer
 *   that said NONE — and it is why the strip happens before the parse rather
 *   than inside it.
 *
 *   PREAMBLES AND FENCES AROUND `NONE`. `isNoneAnswer` demanded that the
 *   WHOLE of stdout be the word, so a polite "Sure! Here is my analysis.\n\n
 *   NONE" and a fenced "```\nNONE\n```" were neither a NONE nor a claim.
 *   They fell through as unreadable output, which was booked NOWHERE — a
 *   foreign model that judged every turn correctly looked exactly like a
 *   runner that never spoke.
 *
 *   CHATTER THAT CONTAINS A BRACE. The hunt ran from the first `{` to the
 *   LAST `}` in stdout, so a perfectly good answer followed by
 *   "Let me know if you want the {full} breakdown!" spanned both and parsed
 *   as nothing. The scan is now brace-BALANCED and string-aware, and it tries
 *   each top-level object in turn (bounded by MAX_JSON_CANDIDATES).
 *
 * WHAT IS DELIBERATELY NOT TOLERATED: the claim CONTRACT itself. Kind and the
 * derived-confidence cap are the schema's, unchanged; the BODY length is
 * deliberately NOT the schema's — a derived draft is capped at
 * SUMMARIZER_DRAFT_BODY_MAX_CHARS so the least trustworthy producer in the
 * system cannot emit the longest records just because the human-facing wire
 * cap rose. An answer that contradicts itself — a claim followed by a bare
 * `NONE` line — resolves to NONE, because dropping a draft is the cheap
 * direction and keeping one the model disowned is not.
 */
import { z } from "zod";
import { ClaimKindSchema, DERIVED_CONFIDENCE_CAP } from "@crosscheck/schema";

import {
  SUMMARIZER_DEFAULT_CONFIDENCE,
  SUMMARIZER_DRAFT_BODY_MAX_CHARS,
} from "../constants.ts";

/** `NONE`, tolerantly: spacing, case, and a stray full stop are all still NONE. */
const NONE_PATTERN = /^none[.!]?$/i;

/**
 * A reasoning model's visible scratchpad, CLOSED. Anchored to the start of a
 * line (with `m`) rather than matched anywhere, so a body that merely quotes
 * the tag — `{"body":"the <think> tag leaks into the log"}` — keeps its
 * text: reasoning blocks are emitted at a line start, quotes are not.
 */
const CLOSED_REASONING_PATTERN =
  /^[ \t]*<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gim;

/**
 * The same block left OPEN, which is what the runner's byte bound produces
 * when a model thinks for longer than SUMMARIZER_OUTPUT_MAX_BYTES: everything
 * from the tag on is scratchpad, and the answer never arrived. Stripping it
 * leaves nothing, which is the honest reading — and is booked as such.
 */
const OPEN_REASONING_PATTERN =
  /^[ \t]*<(?:think|thinking|reasoning)>[\s\S]*$/im;

/**
 * A code-fence MARKER line. Only the marker is dropped, never the fenced
 * content — the claim JSON is usually inside the fence.
 */
const FENCE_LINE_PATTERN = /^\s*(?:`{3,}|~{3,})\s*[A-Za-z0-9_-]*\s*$/;

/**
 * How many top-level `{…}` objects the scan will try before giving up. A
 * model that emits four malformed objects in 16 KiB is not having a bad day
 * with punctuation; the bound keeps a hostile stdout from turning the parse
 * into a search.
 */
const MAX_JSON_CANDIDATES = 4;

/**
 * The answer with a foreign model's packaging removed: reasoning blocks
 * gone, fence markers gone, ends trimmed (which is also what takes the `\r`
 * off a CRLF answer).
 *
 * VERIFY: bun -e 'const {stripModelWrapping: s} = await import("./packages/connector-core/src/model/parse.ts"); console.log(JSON.stringify(s("<think>scratch</think>\nNONE")), JSON.stringify(s("```json\n{\"a\":1}\n```")), JSON.stringify(s("NONE\r\n")))'
 * PRINTS: "NONE" "{\"a\":1}" "NONE"
 */
export const stripModelWrapping = (stdout: string): string =>
  stdout
    .replace(CLOSED_REASONING_PATTERN, "\n")
    .replace(OPEN_REASONING_PATTERN, "\n")
    .split("\n")
    .filter((line) => !FENCE_LINE_PATTERN.test(line))
    .join("\n")
    .trim();

/**
 * `NONE` as the whole answer, or as the final non-empty line of one. The
 * final-line rule is what makes a preamble harmless; it is deliberately
 * STRICT about that line — "Actually, on reflection: NONE" is not a NONE,
 * because a rule that accepted any line ENDING in the word would swallow a
 * sentence that merely used it.
 */
const isNoneText = (text: string): boolean => {
  if (NONE_PATTERN.test(text)) {
    return true;
  }
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const last = lines[lines.length - 1];
  return last !== undefined && NONE_PATTERN.test(last);
};

/**
 * The index of the `}` that closes the `{` at `start`, or -1 if the text
 * runs out first. String-aware, escape-aware: a brace inside a JSON string
 * ("the map {a: 1} broke") must not move the depth, and a truncated object
 * must not report a close it does not have.
 */
const matchingBrace = (text: string, start: number): number => {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
};

/** Balanced top-level `{…}` objects, in order, bounded. */
const jsonObjectCandidates = (text: string): readonly string[] => {
  const found: string[] = [];
  let cursor = 0;
  while (found.length < MAX_JSON_CANDIDATES) {
    const start = text.indexOf("{", cursor);
    if (start === -1) {
      break;
    }
    const end = matchingBrace(text, start);
    if (end === -1) {
      // Nothing from here on can balance either — every later brace is
      // nested inside this unclosed one. A truncated answer, honestly.
      break;
    }
    found.push(text.slice(start, end + 1));
    cursor = end + 1;
  }
  return found;
};

/**
 * What the model may choose: kind, body, and (optionally) confidence. It may
 * NOT choose status, capture mode, provenance or evidence — the worker forces
 * those (draft semantics are non-negotiable).
 */
const DraftOutputSchema = z.looseObject({
  kind: ClaimKindSchema,
  body: z.string().min(1).max(SUMMARIZER_DRAFT_BODY_MAX_CHARS),
  confidence: z.number().min(0).max(1).optional(),
});

export interface DraftOutput {
  readonly kind: z.infer<typeof ClaimKindSchema>;
  readonly body: string;
  /** Already clamped to DERIVED_CONFIDENCE_CAP — never trust a model's zeal. */
  readonly confidence: number;
}

/**
 * Why stdout yielded no answer at all. The split carries a REMEDY and no
 * content: "the binary printed nothing" and "the binary printed something
 * this contract cannot read" send a reader to different places, and neither
 * word is the model's.
 */
export type UnreadableReason = "empty" | "shape";

/** Everything one model answer can turn out to be, decided in one pass. */
export type ModelAnswer =
  | { readonly kind: "none" }
  | { readonly kind: "claim"; readonly draft: DraftOutput }
  | { readonly kind: "unreadable"; readonly why: UnreadableReason };

/**
 * The client-side half of the derived-confidence cap (DESIGN.md §3): the hub
 * refuses derived claims above the cap (ClaimSchema, reused verbatim by the
 * worker's checkClaim pass), and an honest connector never even sends more.
 */
const clampConfidence = (confidence: number | undefined): number =>
  Math.min(
    confidence ?? SUMMARIZER_DEFAULT_CONFIDENCE,
    DERIVED_CONFIDENCE_CAP,
  );

/**
 * ONE PASS over stdout, and the only place the order is decided: strip the
 * packaging, then NONE, then the first top-level object that satisfies the
 * claim contract. NONE is tested BEFORE the objects deliberately — see the
 * header on an answer that contradicts itself.
 *
 * VERIFY: bun -e 'const {readModelAnswer: r} = await import("./packages/connector-core/src/model/parse.ts"); console.log(r("Sure!\nNONE").kind, r("").kind, r("I think so").kind, r("```json\n{\"kind\":\"decision\",\"body\":\"b\",\"confidence\":0.9}\n```").kind, r("{\"kind\":\"decision\",\"body\":\"b\"}\nWant the {full} list?").kind)'
 * PRINTS: none unreadable unreadable claim claim
 */
export const readModelAnswer = (stdout: string): ModelAnswer => {
  const text = stripModelWrapping(stdout);
  if (text.length === 0) {
    return { kind: "unreadable", why: "empty" };
  }
  if (isNoneText(text)) {
    return { kind: "none" };
  }
  for (const candidate of jsonObjectCandidates(text)) {
    let raw: unknown;
    try {
      raw = JSON.parse(candidate) as unknown;
    } catch {
      continue;
    }
    const parsed = DraftOutputSchema.safeParse(raw);
    if (!parsed.success) {
      continue;
    }
    return {
      kind: "claim",
      draft: {
        kind: parsed.data.kind,
        body: parsed.data.body,
        confidence: clampConfidence(parsed.data.confidence),
      },
    };
  }
  return { kind: "unreadable", why: "shape" };
};

/**
 * Whether the model EXPLICITLY answered NONE — the telemetry surface needs
 * this apart from "no draft", because unreadable output is a MODEL problem,
 * not a judged-empty turn, and folding the two would flatter the
 * signal-to-noise figure the trial reads. The intent and ghost workers, whose
 * answers are sentences rather than JSON, ride this directly.
 */
export const isNoneAnswer = (stdout: string): boolean =>
  readModelAnswer(stdout).kind === "none";

/** The claim half of the same pass, for callers that only want the draft. */
export const parseSummarizerOutput = (stdout: string): DraftOutput | null => {
  const answer = readModelAnswer(stdout);
  return answer.kind === "claim" ? answer.draft : null;
};

/**
 * Everything a SENTENCE-shaped answer can turn out to be.
 *
 * WHY THIS EXISTS SEPARATELY FROM `readModelAnswer`. Four tasks sit behind
 * the single `CROSSCHECK_SUMMARIZER_CMD` override, and the argv a wrapper
 * receives is exactly `[cmd]` — nothing on it says which task fired. Two of
 * those tasks want claim JSON (the summarizer, the conference) and two want
 * PROSE (the session intent, the ghost check). So a wrapper that hard-codes
 * one instruction — which is precisely what a foreign-model wrapper must do,
 * and what the documented example does — will answer the other two in the
 * wrong shape, every time.
 *
 * Until this existed the prose pair took the first non-empty line of RAW
 * stdout, whatever that line happened to be. A wrapper carrying the
 * summarizer's instruction therefore published its claim JSON as the
 * developer's session intent, and a reasoning model published the literal
 * `<think>` tag — both booked as SUCCESS, because neither path had an
 * unreadable outcome at all.
 */
export type ModelSentence =
  | { readonly kind: "none" }
  | { readonly kind: "sentence"; readonly text: string }
  | { readonly kind: "unreadable"; readonly why: UnreadableReason };

/**
 * A stripped answer that opens like a DOCUMENT rather than like prose. This
 * is deliberately cruder than the claim parse: `["a","b"]` is not
 * claim-shaped and so is not a `claim`, but it is still emphatically not a
 * sentence, and a reader that only asked "did this parse as a claim" would
 * publish it. Fail CLOSED — a refused answer costs one fire and says why; a
 * published one is a teammate reading JSON as a colleague's intent.
 */
const DOCUMENT_OPENER_PATTERN = /^[{[]/;

/**
 * The prose half of the same stdout, decided in ONE pass and in the same
 * order as the claim half: strip the packaging, then empty, then NONE, then
 * refuse anything document-shaped, and only then take the sentence.
 *
 * The sentence is the first non-empty line, whitespace-collapsed — a model
 * that adds a second line of commentary loses the commentary, not the answer.
 *
 * VERIFY: bun -e 'const {readModelSentence: r} = await import("./packages/connector-core/src/model/parse.ts"); console.log(JSON.stringify([r("").why, r("<think>x</think>\nFind the 500").text, r("Sure!\nNONE").kind, r("{\"kind\":\"decision\",\"body\":\"b\"}").why, r("[\"a\"]").why]))'
 * PRINTS: ["empty","Find the 500","none","shape","shape"]
 */
export const readModelSentence = (stdout: string): ModelSentence => {
  const text = stripModelWrapping(stdout);
  if (text.length === 0) {
    return { kind: "unreadable", why: "empty" };
  }
  if (isNoneText(text)) {
    return { kind: "none" };
  }
  if (
    DOCUMENT_OPENER_PATTERN.test(text) ||
    readModelAnswer(stdout).kind === "claim"
  ) {
    return { kind: "unreadable", why: "shape" };
  }
  const first = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (first === undefined) {
    return { kind: "unreadable", why: "empty" };
  }
  return { kind: "sentence", text: first.replace(/\s+/g, " ") };
};
