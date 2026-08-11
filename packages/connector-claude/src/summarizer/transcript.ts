/**
 * Bounded, local reading of the turn's transcript slice (DESIGN.md §3
 * Tier 1). The transcript is Claude Code's own JSONL session log; this module
 * reads its TAIL — one bounded file read, never the whole file — finds where
 * the current turn began (the last real user prompt), and renders the slice
 * as plain text for the gate's heuristics and the summarizer's prompt.
 *
 * PRIVACY BOUNDARY (§3 / §10 risk 3): everything here stays on this machine.
 * The slice text feeds a locally spawned summarizer; only the schema-validated
 * structured claim it may produce is ever spooled for upload.
 *
 * Byte offsets are absolute file offsets so the Stop hook can gate on the
 * slice it read and hand the detached worker EXACTLY those bounds — the
 * worker re-reads [start, end) and cannot drift onto a newer turn appended
 * after the gate decision.
 */
import {
  SUMMARIZER_BLOCK_MAX_CHARS,
  SUMMARIZER_SLICE_MAX_CHARS,
  SUMMARIZER_TAIL_BYTES,
} from "../constants.ts";

export interface TurnSlice {
  /** Absolute byte offset of the current turn's first transcript line. */
  readonly start: number;
  /** Absolute byte offset one past the last byte read. */
  readonly end: number;
  /** The raw JSONL bytes of [start, end), as text. */
  readonly raw: string;
}

interface ContentBlock {
  readonly type?: string;
  readonly text?: string;
  readonly name?: string;
  readonly input?: unknown;
  readonly content?: unknown;
}

interface TranscriptEntry {
  readonly type?: string;
  readonly message?: {
    readonly content?: unknown;
  };
}

const parseEntry = (line: string): TranscriptEntry | null => {
  try {
    const parsed = JSON.parse(line) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as TranscriptEntry)
      : null;
  } catch {
    return null;
  }
};

const contentBlocks = (entry: TranscriptEntry): readonly ContentBlock[] => {
  const content = entry.message?.content;
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter(
    (block): block is ContentBlock =>
      typeof block === "object" && block !== null,
  );
};

/**
 * A REAL user prompt: a user entry carrying text and no tool_result. Tool
 * results also arrive as user-role entries, and starting the slice at one
 * would fold the previous turn's diagnosis into this turn's capture.
 */
const isRealUserPrompt = (entry: TranscriptEntry): boolean => {
  if (entry.type !== "user") {
    return false;
  }
  const blocks = contentBlocks(entry);
  if (blocks.some((block) => block.type === "tool_result")) {
    return false;
  }
  return blocks.some(
    (block) => block.type === "text" && typeof block.text === "string",
  );
};

const NEWLINE_BYTE = 0x0a;

/**
 * The tail of the file as BYTES, plus the absolute offset of its first WHOLE
 * line. A read that starts mid-file lands mid-line; the fragment before the
 * first newline belongs to a line whose beginning was not read, so it is
 * dropped and the offset advanced past it.
 *
 * All offset arithmetic stays on the raw bytes, never the decoded text: a
 * tail boundary that splits a multibyte UTF-8 character decodes to U+FFFD
 * replacement characters whose byte length differs from the original bytes,
 * and offsets computed from that decoding drift — the worker would then
 * re-read DIFFERENT bytes than the gate saw. Pinned by the multibyte
 * boundary test in test/stop-gate.test.ts.
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

/**
 * The current turn's slice: from the LAST real user prompt in the bounded
 * tail to the end of what was read. No user prompt in the tail (a turn
 * longer than the tail window) degrades to the whole tail — still bounded,
 * still only the most recent activity. Null on any failure (fail open).
 *
 * Line walking is byte-indexed (readTailBytes says why); each line is
 * decoded only to PARSE it, never to measure it.
 */
export const readTurnSlice = async (
  path: string,
): Promise<TurnSlice | null> => {
  const tail = await readTailBytes(path);
  if (tail === null || tail.bytes.length === 0) {
    return null;
  }
  let cursor = 0;
  let sliceStartRelative = 0;
  while (cursor < tail.bytes.length) {
    const newlineAt = tail.bytes.indexOf(NEWLINE_BYTE, cursor);
    const lineEnd = newlineAt === -1 ? tail.bytes.length : newlineAt;
    const lineText = tail.bytes.subarray(cursor, lineEnd).toString();
    const entry = lineText.length === 0 ? null : parseEntry(lineText);
    if (entry !== null && isRealUserPrompt(entry)) {
      sliceStartRelative = cursor;
    }
    cursor = lineEnd + 1;
  }
  return {
    start: tail.offset + sliceStartRelative,
    end: tail.offset + tail.bytes.length,
    raw: tail.bytes.subarray(sliceStartRelative).toString(),
  };
};

/** The worker's re-read of the exact bytes the gate decided on. */
export const readSliceRange = async (
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

const blockText = (block: ContentBlock): string | null => {
  if (block.type === "text" && typeof block.text === "string") {
    return cap(block.text);
  }
  if (block.type === "tool_use") {
    const name = typeof block.name === "string" ? block.name : "tool";
    let input = "";
    try {
      input = JSON.stringify(block.input) ?? "";
    } catch {
      input = "";
    }
    return `tool_use ${name}: ${cap(input)}`;
  }
  if (block.type === "tool_result") {
    const content = block.content;
    if (typeof content === "string") {
      return `tool_result: ${cap(content)}`;
    }
    if (Array.isArray(content)) {
      const texts = content
        .filter(
          (item): item is { text: string } =>
            typeof item === "object" &&
            item !== null &&
            typeof (item as { text?: unknown }).text === "string",
        )
        .map((item) => item.text)
        .join("\n");
      return `tool_result: ${cap(texts)}`;
    }
    return null;
  }
  return null;
};

/**
 * The slice as plain text: role-labelled lines, each block capped, the whole
 * capped at SUMMARIZER_SLICE_MAX_CHARS keeping the TAIL — when a turn is too
 * long, the diagnosis is at its end, not its start.
 */
export const extractSliceText = (raw: string): string => {
  const rendered = raw
    .split("\n")
    .filter((lineText) => lineText.length > 0)
    .flatMap((lineText) => {
      const entry = parseEntry(lineText);
      if (entry === null) {
        return [];
      }
      const role = entry.type === "user" ? "user" : "assistant";
      return contentBlocks(entry).flatMap((block) => {
        const text = blockText(block);
        return text === null || text.length === 0 ? [] : [`${role}: ${text}`];
      });
    })
    .join("\n");
  return rendered.slice(-SUMMARIZER_SLICE_MAX_CHARS);
};
