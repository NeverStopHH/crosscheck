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
} from "@crosscheck/connector-core/constants.ts";

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
 * One rendered entry, and whether it can be the turn's ASK.
 *
 * THE FLAG IS DECIDED WHERE THE BLOCK IS, not read back off the rendered text
 * afterwards, and that is the whole point of this type. Two facts are lost the
 * moment the entries are joined into one document:
 *
 *   A rendered entry KEEPS THE AUTHOR'S NEWLINES. `blockText` caps a block but
 *   does not reflow it, so a pasted failing case or a bullet list — how a
 *   developer types half their prompts — is one entry spanning several lines,
 *   and a finder scanning lines takes only the first of them. The first line is
 *   routinely the least informative half ("here is the failing case:").
 *
 *   A TOOL RESULT IS ALSO A `user` ENTRY in this wire format, and its content
 *   is text the agent READ — a log, a file, a fetched page. Its inner lines are
 *   indistinguishable from an entry boundary once joined, so a line of borrowed
 *   text beginning "user: " read back as the ask, and on the no-ask branch
 *   below (a turn longer than the tail read, where there is no real ask) that
 *   borrowed line was prepended at the very front of the summarizer's context
 *   as the developer's own question. The answer it shapes is filed as a
 *   `derived` claim teammates can pull (DESIGN.md §3), so the borrowed sentence
 *   would be steering a surface this product treats as untrusted everywhere
 *   else.
 *
 * `isAsk` is therefore positive equality on what the block WAS: a user entry
 * carrying a text block. A tool result cannot satisfy it whatever it contains,
 * and an unknown future block type fails closed to "not an ask".
 */
interface RenderedEntry {
  /** The role-labelled text, exactly as it goes to the model. */
  readonly line: string;
  /** A user TEXT block — the only thing the turn's ask can be. */
  readonly isAsk: boolean;
}

/**
 * Said out loud, because a slice that silently jumps from the question to the
 * last few tool results reads as a complete turn, and a model asked to
 * conclude from it will conclude from what it can see.
 */
export const OMITTED_MARKER = "[... middle of this turn omitted for length ...]";

/**
 * The slice as plain text: role-labelled lines, each block capped, the whole
 * capped at SUMMARIZER_SLICE_MAX_CHARS.
 *
 * HEAD PLUS TAIL, not tail alone (audit rows M16 / A3-4). It kept only the
 * last 24,000 characters, and on a long turn — a build log, a test run, a
 * file read — that window closed above the user's own question, so the model
 * was asked what this turn concluded while holding only its final tool
 * output, and a summarizer that cannot see the ask answers about the last
 * thing it can see: the narration and role-play `summarizer/reject.ts` now has
 * to refuse.
 *
 * HOW OFTEN, IN TWO FIGURES OF DIFFERENT STANDING. The trial measured 60 % of
 * gate-positive slices arriving that way — HISTORICAL, taken on a live install
 * whose transcripts are not in this tree, so no command here re-derives it and
 * none is offered. What IS re-runnable is the same question asked of the
 * conclusion corpus, and it is a test rather than a sentence: `conclusion
 * corpus: a long turn still carries its own ask` in
 * connector-claude/test/conclusion-corpus.test.ts stretches all seven
 * gate-positive fixtures past this cut and holds every one of them to
 * FLOOR_CONCLUSION_ASK_RETENTION.
 *
 * The fix is the position-bias result rather than a bigger window: models
 * retrieve reliably from the START and the END of a context and least
 * reliably from the middle (Liu et al., "Lost in the Middle", TACL 2024), so
 * the ask is prepended and the tail keeps the rest of the SAME budget.
 *
 * RAISING SUMMARIZER_TAIL_BYTES — the audit row's other half — was not the
 * alternative it reads as, and an earlier version of this comment refused it
 * for the wrong reason (that it would spend the developer's quota). It would
 * not: TAIL_BYTES bounds the FILE READ, the cut below bounds what reaches the
 * model, and the two are 131,072 and 24,000. Reading more of the transcript
 * therefore costs I/O and not one token — and fixes nothing on its own,
 * because the tail cut would close above the ask exactly as before. The
 * constant that WOULD have paid for the ask out of the quota (DESIGN.md §10
 * risk 7) on every fire, including the many that do not need it, is
 * SUMMARIZER_SLICE_MAX_CHARS, and it is untouched: a transcript longer than
 * the whole read window still yields exactly the cap, with the ask on top.
 *
 * VERIFY: bun -e 'const t=await import("./packages/connector-claude/src/summarizer/transcript.ts");const c=await import("./packages/connector-core/src/constants.ts");const l=(e)=>JSON.stringify(e)+"\n";const raw=l({type:"user",message:{content:[{type:"text",text:"why does the importer stall"}]}})+l({type:"user",message:{content:[{type:"tool_result",content:"x".repeat(2000)}]}}).repeat(100)+l({type:"assistant",message:{content:[{type:"text",text:"Root cause: one token bucket"}]}});const s=t.extractSliceText(raw);console.log(c.SUMMARIZER_TAIL_BYTES, c.SUMMARIZER_SLICE_MAX_CHARS, raw.length>c.SUMMARIZER_TAIL_BYTES, s.length===c.SUMMARIZER_SLICE_MAX_CHARS, s.startsWith("user: why does the importer stall"))'
 * PRINTS: 131072 24000 true true true
 */
export const extractSliceText = (raw: string): string => {
  const entries: readonly RenderedEntry[] = raw
    .split("\n")
    .filter((lineText) => lineText.length > 0)
    .flatMap((lineText) => {
      const entry = parseEntry(lineText);
      if (entry === null) {
        return [];
      }
      const isUser = entry.type === "user";
      const role = isUser ? "user" : "assistant";
      return contentBlocks(entry).flatMap((block) => {
        const text = blockText(block);
        return text === null || text.length === 0
          ? []
          : [
              {
                line: `${role}: ${text}`,
                isAsk: isUser && block.type === "text",
              },
            ];
      });
    });
  const rendered = entries.map((entry) => entry.line).join("\n");
  if (rendered.length <= SUMMARIZER_SLICE_MAX_CHARS) {
    return rendered;
  }
  // The FIRST user text block, not the first line that looks like one:
  // `readTurnSlice` starts the slice at the last real user prompt, so on an
  // ordinary turn that entry is the question the turn is about.
  const ask = entries.find((entry) => entry.isAsk)?.line;
  // No ask in the slice at all (a turn longer than the tail window, so the
  // read began mid-turn), or an ask so long it would leave no room for the
  // conclusion: the tail alone, exactly as before. `blockText` already capped
  // the entry at SUMMARIZER_BLOCK_MAX_CHARS, so the head is bounded at that
  // plus the marker whatever the author pasted.
  const head = ask === undefined ? "" : `${ask}\n${OMITTED_MARKER}\n`;
  if (head.length === 0 || head.length >= SUMMARIZER_SLICE_MAX_CHARS) {
    return rendered.slice(-SUMMARIZER_SLICE_MAX_CHARS);
  }
  return `${head}${rendered.slice(-(SUMMARIZER_SLICE_MAX_CHARS - head.length))}`;
};
