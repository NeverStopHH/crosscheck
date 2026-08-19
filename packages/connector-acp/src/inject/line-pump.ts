/**
 * The line-granular client→agent pump — Block 5's forward path, used ONLY
 * while injection is active (proxy.ts keeps the Block-3 chunk pump when it
 * is not, which is what makes the disabled wire byte-identical by
 * construction, not by care).
 *
 * WHY LINES: the two write points (§2.5) are whole JSON-RPC messages, and a
 * message can only be recognized once its line is complete — so this pump
 * buffers up to one line, hands the COMPLETE line to the handler, and
 * forwards whatever the handler returns: null → the ORIGINAL bytes,
 * untouched (the overwhelmingly common case — §2.3 rule 1 holds per line);
 * replacement text → that one message re-serialized, rule 1's sanctioned
 * exception.
 *
 * WHAT IT PRESERVES:
 *   - ORDER, absolutely (§2.3 rule 3): one line fully decided and written
 *     before the next is looked at. A held prompt (hint budget) delays
 *     later lines rather than being overtaken — reordering a cancel past
 *     its own prompt would cancel nothing; the hold is budget-bounded.
 *   - TERMINATORS: a `\r\n` line comes back `\r\n`, injected or not.
 *   - BOUNDED MEMORY: past ACP_INJECT_MAX_LINE_BYTES the buffered bytes are
 *     flushed verbatim and the rest of the line streams through untouched
 *     (nothing injectable is ever that large); a trailing partial line at
 *     EOF flushes verbatim.
 *   - BACKPRESSURE: awaits the sink per write, exactly like pump.ts — one
 *     piece in flight, never more.
 *   - FAIL-OPEN (§2.3 rule 6): a throwing handler forwards the original
 *     bytes and counts the error; the wire never sees a handler bug.
 *
 * The observer is fed the FORWARDED bytes (post-injection): capture and
 * `--record` must see the wire the agent saw.
 */
import type { ByteSink, ChunkObserver, PumpOutcome } from "../pump.ts";
import { ACP_INJECT_MAX_LINE_BYTES } from "../constants.ts";

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * The injection decision for one complete line (without its terminator):
 * null forwards the original bytes; a string replaces the whole line (the
 * pump reattaches the original terminator).
 */
export type LineDecision = string | null;
export type LineHandler = (text: string) => Promise<LineDecision>;

export interface LinePumpOutcome extends PumpOutcome {
  /** Complete lines the handler saw. */
  readonly linesHandled: number;
  /** Lines replaced by the handler (the injections). */
  readonly linesReplaced: number;
  /** Handler throws, swallowed onto the forward-original path. */
  readonly handlerErrors: number;
}

interface MutableCounters {
  bytesForwarded: number;
  observerErrors: number;
  linesHandled: number;
  linesReplaced: number;
  handlerErrors: number;
}

const concatParts = (parts: readonly Uint8Array[], total: number): Uint8Array => {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
};

export const pumpLines = async (
  source: AsyncIterable<Uint8Array>,
  sink: ByteSink,
  handler: LineHandler,
  observe?: ChunkObserver,
  maxLineBytes: number = ACP_INJECT_MAX_LINE_BYTES,
): Promise<LinePumpOutcome> => {
  const counters: MutableCounters = {
    bytesForwarded: 0,
    observerErrors: 0,
    linesHandled: 0,
    linesReplaced: 0,
    handlerErrors: 0,
  };
  let parts: Uint8Array[] = [];
  let buffered = 0;
  let passthrough = false;
  let writeError: unknown;
  let sourceError: unknown;

  const write = async (bytes: Uint8Array): Promise<boolean> => {
    if (bytes.byteLength === 0) {
      return true;
    }
    try {
      const started = sink.write(bytes);
      if (started instanceof Promise) {
        await started; // backpressure: one piece in flight, never more
      }
    } catch (error) {
      writeError = error;
      return false;
    }
    counters.bytesForwarded += bytes.byteLength;
    if (observe !== undefined) {
      try {
        observe(bytes);
      } catch {
        counters.observerErrors += 1;
      }
    }
    return true;
  };

  const takeBuffered = (): Uint8Array => {
    const line = concatParts(parts, buffered);
    parts = [];
    buffered = 0;
    return line;
  };

  /** One COMPLETE line (terminator included) through the handler. */
  const handleLine = async (line: Uint8Array): Promise<boolean> => {
    // Terminator split: `\n`, with an optional `\r` before it.
    const hasCr =
      line.byteLength >= 2 && line[line.byteLength - 2] === CARRIAGE_RETURN;
    const bodyEnd = line.byteLength - (hasCr ? 2 : 1);
    counters.linesHandled += 1;
    let decision: LineDecision = null;
    try {
      decision = await handler(decoder.decode(line.subarray(0, bodyEnd)));
    } catch {
      counters.handlerErrors += 1; // fail open: original bytes go through
    }
    if (decision === null) {
      return write(line);
    }
    counters.linesReplaced += 1;
    return write(encoder.encode(`${decision}${hasCr ? "\r\n" : "\n"}`));
  };

  try {
    outer: for await (const chunk of source) {
      let start = 0;
      for (let index = 0; index < chunk.byteLength; index += 1) {
        if (chunk[index] !== NEWLINE) {
          continue;
        }
        const segment = chunk.subarray(start, index + 1);
        start = index + 1;
        if (passthrough) {
          // The tail of an oversized line: verbatim, then back to lines.
          if (!(await write(new Uint8Array(segment)))) {
            break outer;
          }
          passthrough = false;
          continue;
        }
        if (buffered + segment.byteLength > maxLineBytes) {
          // Nothing injectable is this large: flush what was held, stream
          // the rest — unchanged bytes, bounded memory.
          if (!(await write(takeBuffered()))) {
            break outer;
          }
          if (!(await write(new Uint8Array(segment)))) {
            break outer;
          }
          continue;
        }
        parts.push(new Uint8Array(segment));
        buffered += segment.byteLength;
        if (!(await handleLine(takeBuffered()))) {
          break outer;
        }
      }
      if (start < chunk.byteLength) {
        const tail = chunk.subarray(start);
        if (passthrough) {
          if (!(await write(new Uint8Array(tail)))) {
            break outer;
          }
        } else if (buffered + tail.byteLength > maxLineBytes) {
          if (!(await write(takeBuffered()))) {
            break outer;
          }
          if (!(await write(new Uint8Array(tail)))) {
            break outer;
          }
          passthrough = true;
        } else {
          // The tail must be copied: the source reuses its buffer once the
          // write resolves (the pump chunk contract).
          parts.push(new Uint8Array(tail));
          buffered += tail.byteLength;
        }
      }
    }
  } catch (error) {
    sourceError = error;
  }
  // EOF with a partial line: verbatim, never handled — a frame the client
  // never finished is not a message (and Block 3 forwarded it too).
  if (buffered > 0 && writeError === undefined) {
    await write(takeBuffered());
  }
  return {
    bytesForwarded: counters.bytesForwarded,
    observerErrors: counters.observerErrors,
    writeError,
    sourceError,
    linesHandled: counters.linesHandled,
    linesReplaced: counters.linesReplaced,
    handlerErrors: counters.handlerErrors,
  };
};
