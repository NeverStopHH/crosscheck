/**
 * The NDJSON line observer: Block 3's whole parse layer. It works on a COPY
 * of the wire (§2.3 rule 2 — the pump hands it copies, never the buffers it
 * forwards), reassembles newline-delimited lines, tries JSON on each, and
 * COUNTS what it cannot use instead of judging it (§2.3 rule 4). Nothing it
 * returns feeds back into forwarding; its consumers are `--record` and the
 * drop counters in the proxy log.
 *
 * Memory is bounded by construction: a line past `maxLineBytes` drops its
 * buffered copy and skips to the next newline, so the observer's high-water
 * mark never exceeds the cap however large a single wire line grows.
 */
import { ACP_MAX_PARSE_LINE_BYTES } from "./constants.ts";

/** One completed NDJSON line, as observed. */
export interface ObservedLine {
  readonly kind: "line" | "oversized";
  /** Raw line text without the trailing newline (`\r` kept). Empty for oversized. */
  readonly text: string;
  /** Whether the text parsed as JSON. Always false for oversized. */
  readonly parsedOk: boolean;
  /** Bytes of the line on the wire, newline excluded. */
  readonly bytes: number;
  /** True when the stream ended without a newline (crash mid-frame). */
  readonly atEof: boolean;
}

export interface ObserverCounters {
  /** Completed non-blank lines, oversized included. */
  readonly lines: number;
  /** Lines that did not parse as JSON — forwarded anyway, counted here. */
  readonly unparseable: number;
  /** Lines past the parse-copy cap — forwarded anyway, copy dropped. */
  readonly oversized: number;
  /** Total bytes pushed, newlines included. */
  readonly bytes: number;
  /** High-water mark of the internal line buffer — the memory bound. */
  readonly peakBufferedBytes: number;
}

export interface LineObserver {
  push(chunk: Uint8Array): readonly ObservedLine[];
  /** Stream end: flushes a trailing partial line, if any. */
  end(): readonly ObservedLine[];
  counters(): ObserverCounters;
}

const NEWLINE = 0x0a;

/** Lossy on invalid UTF-8 by design: the decode feeds the parse copy only. */
const decoder = new TextDecoder();

const concatParts = (parts: readonly Uint8Array[], total: number): Uint8Array => {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
};

export const createLineObserver = (
  maxLineBytes: number = ACP_MAX_PARSE_LINE_BYTES,
): LineObserver => {
  let parts: Uint8Array[] = [];
  let buffered = 0;
  let overflowed = false;
  let overflowBytes = 0;
  let lines = 0;
  let unparseable = 0;
  let oversized = 0;
  let bytes = 0;
  let peak = 0;

  const append = (part: Uint8Array): void => {
    if (part.byteLength === 0) return;
    if (overflowed) {
      overflowBytes += part.byteLength;
      return;
    }
    if (buffered + part.byteLength > maxLineBytes) {
      // The copy is dropped, never the wire: forwarding happened upstream.
      overflowed = true;
      overflowBytes = buffered + part.byteLength;
      parts = [];
      buffered = 0;
      return;
    }
    parts.push(part);
    buffered += part.byteLength;
    if (buffered > peak) peak = buffered;
  };

  const takeLine = (atEof: boolean): ObservedLine | null => {
    const wasOverflowed = overflowed;
    const totalBytes = wasOverflowed ? overflowBytes : buffered;
    const raw = wasOverflowed ? new Uint8Array(0) : concatParts(parts, buffered);
    parts = [];
    buffered = 0;
    overflowed = false;
    overflowBytes = 0;
    if (wasOverflowed) {
      oversized += 1;
      lines += 1;
      return { kind: "oversized", text: "", parsedOk: false, bytes: totalBytes, atEof };
    }
    const text = decoder.decode(raw);
    if (text.trim().length === 0) {
      return null; // blank keepalive — nothing to observe, nothing to count
    }
    lines += 1;
    let parsedOk = true;
    try {
      JSON.parse(text);
    } catch {
      parsedOk = false;
      unparseable += 1;
    }
    return { kind: "line", text, parsedOk, bytes: totalBytes, atEof };
  };

  return {
    push(chunk) {
      bytes += chunk.byteLength;
      const events: ObservedLine[] = [];
      let start = 0;
      for (let index = 0; index < chunk.byteLength; index += 1) {
        if (chunk[index] !== NEWLINE) continue;
        append(chunk.subarray(start, index));
        const event = takeLine(false);
        if (event !== null) events.push(event);
        start = index + 1;
      }
      if (start < chunk.byteLength) {
        // The trailing remainder is the ONLY bytes that survive this call,
        // and the caller's buffer does not (the pump reuses its scratch) —
        // so the tail is copied, and everything consumed above was decoded
        // before returning. new Uint8Array, not slice(): Buffer's slice()
        // is a view.
        append(new Uint8Array(chunk.subarray(start)));
      }
      return events;
    },
    end() {
      if (buffered === 0 && !overflowed) return [];
      const event = takeLine(true);
      return event === null ? [] : [event];
    },
    counters() {
      return { lines, unparseable, oversized, bytes, peakBufferedBytes: peak };
    },
  };
};
