/**
 * The Cursor turn slice — the ONE part of the Tier-1 summarizer a host has to
 * own, because only the host knows where its transcript is and what is in it.
 *
 * WHAT IS DOCUMENTED, AND WHAT IS NOT. Cursor documents the POINTER, twice:
 * every hook's common input carries `transcript_path` ("string | null — Path
 * to the main conversation transcript file (null if transcripts disabled)")
 * and every hook process gets `CURSOR_TRANSCRIPT_PATH` in its environment
 * ("If transcripts enabled"). Both re-read from cursor.com/docs/hooks on
 * 2026-08-28; test/fixtures/cursor-contract/docs-excerpt-cursor-hooks.md
 * holds the offline copy. What is NOT documented anywhere is the file's
 * CONTENT — no schema, no example, not even an extension for the main
 * transcript (the subagentStop payload's `agent_transcript_path` example ends
 * in `.txt`, which is a hint about a different file and nothing more).
 *
 * SO THIS READER IS SHAPE-TOLERANT ON PURPOSE, and says which shape it found
 * rather than assuming one. Two decoders, tried in order over the same
 * bounded tail bytes:
 *
 *   `jsonl` — one JSON object per line carrying text somewhere this decoder
 *             recognises. This is the shape Claude Code writes and the shape
 *             Cursor's Claude-compatibility elsewhere makes plausible; it is
 *             a HYPOTHESIS, not a recorded fact, and the fixture beside it
 *             says so in those words.
 *   `text`  — anything else that decoded to printable characters: the tail
 *             taken as prose. Weaker (no role labels, no tool boundaries) and
 *             deliberately still useful, because the gate's anchors are
 *             command shapes and error output, which survive being read as
 *             prose. "PRINTABLE" IS ENFORCED (isProse below) and not merely
 *             described: for one review cycle this branch it was a sentence
 *             in this header and nothing else, so the fallback returned any
 *             non-blank tail — a SQLite page, a stream of decode failures —
 *             as a slice, and the null below was reachable only for a tail
 *             that is entirely whitespace. That made the named outcome three
 *             lines down unreachable in practice and the tripwire decorative.
 *
 * Neither decoder guessing right is a NAMED outcome, never a silence: the
 * caller books `withSummarizerNoSlice` with one of the reasons below and the
 * Cursor doctor section prints it as a sentence. That is the whole difference
 * between "capture degrades until someone runs doctor" and "capture degrades
 * and nobody ever finds out".
 *
 * WHICH ONE MATCHED IS REPORTED, likewise for real: the caller carries `shape`
 * into session state (core gate.ts withSummarizerSliceShape) and the Cursor
 * doctor rung prints it. The jsonl decoder is a hypothesis about a format
 * nobody publishes; when it stops matching, prose takes over, the gate is
 * handed a weaker slice, and no counter anywhere moves — a slice WAS produced
 * and no model failed. The printed shape is the only surface that flip has.
 *
 * PRIVACY: the path is read, never stored — it does not enter session state,
 * the spool, the drift ledger or any doctor line (doctor says WHETHER a
 * transcript was available, never where). The bytes are decoded in memory,
 * handed to a locally spawned model's stdin by the worker, and dropped.
 *
 * Byte offsets are absolute file offsets, the Claude reader's discipline and
 * for the same reason: the stop handler gates on the slice it read and hands
 * the detached worker EXACTLY those bounds, so a turn appended between the
 * gate decision and the worker's read cannot drift into the fire.
 *
 * THE SECOND REDUCTION, said out loud because it is invisible in the output:
 * this slice is the tail of the CONVERSATION, not of the turn. The Claude
 * reader walks its JSONL for the last real user prompt and starts the slice
 * there — it can, because Claude Code documents an entry type that means "the
 * user said this" and a tool result is distinguishable from it. Cursor
 * documents no transcript schema at all, so there is no marker to find; a
 * turn boundary guessed from an undocumented format would be a guess printed
 * as a fact, and the gate would silently start slicing in the wrong place the
 * day the guess stopped holding. So the slice is the bounded tail, and what
 * the model is shown may include the end of the previous turn.
 *
 * The cost of that is bounded and the direction is the safe one: a slice with
 * MORE context than the turn makes the gate's conjunction slightly easier to
 * satisfy (a conclusion in this turn beside a test command in the last one),
 * which spends a capped fire on a weaker moment — it never invents a
 * conclusion, because the model is asked for one and answers NONE when there
 * is none, and NONE is a booked outcome. The debounce and the per-session cap
 * bound how often that can happen at all.
 */
import {
  SUMMARIZER_BLOCK_MAX_CHARS,
  SUMMARIZER_SLICE_MAX_CHARS,
  SUMMARIZER_TAIL_BYTES,
} from "@crosscheck/connector-core/constants.ts";

/** The reasons a turn produced no slice — crosscheck's own words, always. */
export const NO_SLICE_NO_TRANSCRIPT =
  "no transcript: this Cursor build sent none";
export const NO_SLICE_UNREADABLE = "the transcript could not be read";
export const NO_SLICE_UNRECOGNISED =
  "the transcript tail decoded to nothing usable";

export type CursorSliceShape = "jsonl" | "text";

export interface CursorTurnSlice {
  /** Absolute byte offset of the first WHOLE line in the bounded tail. */
  readonly start: number;
  /** Absolute byte offset one past the last byte read. */
  readonly end: number;
  readonly raw: string;
}

const NEWLINE_BYTE = 0x0a;

/**
 * The tail of the file as BYTES, plus the absolute offset of its first whole
 * line. A read that starts mid-file lands mid-line; the fragment before the
 * first newline belongs to a line whose beginning was not read, so it is
 * dropped and the offset advanced past it.
 *
 * All offset arithmetic stays on the raw bytes, never the decoded text: a
 * tail boundary that splits a multibyte character decodes to U+FFFD, whose
 * byte length differs from the original, and offsets computed from that
 * decoding would send the worker to different bytes than the gate saw.
 */
const readTailBytes = async (
  path: string,
): Promise<{ readonly offset: number; readonly bytes: Buffer } | null> => {
  try {
    const file = Bun.file(path);
    const size = file.size;
    if (!Number.isFinite(size) || size <= 0) {
      return null;
    }
    const tailStart = Math.max(0, size - SUMMARIZER_TAIL_BYTES);
    const bytes = Buffer.from(await file.slice(tailStart, size).arrayBuffer());
    if (tailStart === 0) {
      return { offset: 0, bytes };
    }
    const firstNewline = bytes.indexOf(NEWLINE_BYTE);
    if (firstNewline === -1) {
      // One line longer than the whole tail window: nothing here is a whole
      // line, and a fragment of one would start mid-token. Honest null.
      return null;
    }
    return {
      offset: tailStart + firstNewline + 1,
      bytes: bytes.subarray(firstNewline + 1),
    };
  } catch {
    return null;
  }
};

/** The bounded tail of the transcript, or null (unreadable / empty / absent). */
export const readCursorTurnSlice = async (
  path: string,
): Promise<CursorTurnSlice | null> => {
  const tail = await readTailBytes(path);
  if (tail === null || tail.bytes.length === 0) {
    return null;
  }
  return {
    start: tail.offset,
    end: tail.offset + tail.bytes.length,
    raw: tail.bytes.toString(),
  };
};

/** The worker's re-read of the exact bytes the stop handler decided on. */
export const readCursorSliceRange = async (
  path: string,
  start: number,
  end: number,
): Promise<string | null> => {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end - start > SUMMARIZER_TAIL_BYTES
  ) {
    return null;
  }
  try {
    return await Bun.file(path).slice(start, end).text();
  } catch {
    return null;
  }
};

const cap = (text: string): string => text.slice(0, SUMMARIZER_BLOCK_MAX_CHARS);

/**
 * Where a JSON transcript entry might keep its text. Deliberately a LIST and
 * not one path: the format is undocumented, so the honest posture is to
 * recognise the handful of shapes every agent transcript in this space uses
 * and to report which one matched — not to pick one and call it the contract.
 */
const entryText = (entry: Record<string, unknown>): string | null => {
  const direct = entry["text"];
  if (typeof direct === "string" && direct.trim().length > 0) {
    return cap(direct);
  }
  const content = entry["content"] ?? (entry["message"] as
    | Record<string, unknown>
    | undefined)?.["content"];
  if (typeof content === "string" && content.trim().length > 0) {
    return cap(content);
  }
  if (Array.isArray(content)) {
    const joined = content
      .flatMap((block) => {
        if (typeof block === "string") {
          return [block];
        }
        if (typeof block !== "object" || block === null) {
          return [];
        }
        const blockText = (block as Record<string, unknown>)["text"];
        return typeof blockText === "string" ? [blockText] : [];
      })
      .join("\n");
    return joined.trim().length === 0 ? null : cap(joined);
  }
  return null;
};

const roleOf = (entry: Record<string, unknown>): string => {
  const candidate = entry["role"] ?? entry["type"];
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : "entry";
};

/**
 * Letters and digits in any script — what "words" means for a reader that has
 * to work on a German stack trace and a Japanese comment alike.
 */
const WORD_CHAR = /[\p{L}\p{N}]/gu;

/**
 * Characters no transcript writes and every failed decode produces: C0 and C1
 * control codes minus the three that are ordinary text (tab, LF, CR), plus
 * U+FFFD, which is exactly what `Buffer.toString()` leaves behind for a byte
 * sequence that is not UTF-8.
 */
const UNREADABLE_CHAR =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFD]/gu;

/**
 * A tail with fewer letters or digits than this carries no anchor the gate
 * could match anyway — `isCaptureMoment` looks for command shapes and error
 * output — so accepting one would spend a capped fire on nothing. The bound
 * is deliberately tiny against a 128 KiB tail of a whole conversation: it is
 * a floor for "is this text at all", not a judgement about content.
 */
const PROSE_MIN_WORD_CHARS = 20;

/**
 * One character in ten being a control code or a decode failure is not prose
 * in any language. A legitimate tail carries none at all: the reader drops
 * the partial first line whenever it started mid-file (readTailBytes), which
 * is the only place a split multibyte character could appear, and it always
 * reads through to EOF, so the far end cannot be split either.
 */
const PROSE_MAX_UNREADABLE_RATIO = 0.1;

/**
 * Whether the fallback may offer this tail as prose. The rule the header has
 * always described and the code did not apply — refusing here is what makes
 * NO_SLICE_UNRECOGNISED a reachable outcome, and therefore what makes a
 * transcript format this reader does not understand a booked, printed fact
 * rather than a permanent quiet PASS.
 *
 * VERIFY: bun -e 'const {extractCursorSliceText:x}=await import("./packages/connector-cursor/src/derive/transcript.ts");const bin=Buffer.concat([Buffer.from("SQLite format 3"),Buffer.from([0,16,1,1,0,64,32,32,10])]).toString();console.log(x(bin), x("### --- >>>"), x("user: ran bun test src/auth and 3 tests failed").shape)'
 * PRINTS: null null text
 */
const isProse = (text: string): boolean => {
  if ((text.match(WORD_CHAR) ?? []).length < PROSE_MIN_WORD_CHARS) {
    return false;
  }
  return (
    (text.match(UNREADABLE_CHAR) ?? []).length <=
    text.length * PROSE_MAX_UNREADABLE_RATIO
  );
};

/**
 * The tail as text the gate and the model can read, plus WHICH decoder
 * produced it. Null when neither did — the caller books that.
 *
 * The final cut keeps the TAIL of the rendered document rather than its head:
 * a conclusion is at the end of a turn, and unlike the Claude reader there is
 * no reliable "this line was the user's ask" marker in an undocumented format
 * to prepend, so inventing one would be a guess printed as a fact.
 */
export const extractCursorSliceText = (
  raw: string,
): { readonly text: string; readonly shape: CursorSliceShape } | null => {
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const rendered = lines.flatMap((line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      return [];
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return [];
    }
    const entry = parsed as Record<string, unknown>;
    const text = entryText(entry);
    return text === null ? [] : [`${roleOf(entry)}: ${text}`];
  });
  if (rendered.length > 0) {
    const joined = rendered.join("\n");
    return { text: joined.slice(-SUMMARIZER_SLICE_MAX_CHARS), shape: "jsonl" };
  }
  const prose = lines.join("\n").trim();
  if (!isProse(prose)) {
    return null;
  }
  return { text: prose.slice(-SUMMARIZER_SLICE_MAX_CHARS), shape: "text" };
};
