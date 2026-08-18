/**
 * The NDJSON line observer — the parse layer that works on a COPY (§2.3
 * rule 2). Nothing here touches forwarding; these tests pin what the observer
 * reports (lines, drop counters) and, critically, that its memory stays
 * bounded whatever the wire carries (§4.2 layer 1's 10 MB line).
 */
import { describe, expect, test } from "bun:test";

import { ACP_MAX_PARSE_LINE_BYTES } from "../src/constants.ts";
import { createLineObserver } from "../src/observer.ts";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("line reassembly", () => {
  test("reassembles a frame split across pushes", () => {
    // Arrange
    const observer = createLineObserver();

    // Act
    const first = observer.push(encode('{"jsonrpc":"2.0",'));
    const second = observer.push(encode('"id":1}\n'));

    // Assert
    expect(first).toEqual([]);
    expect(second).toHaveLength(1);
    expect(second[0]?.text).toBe('{"jsonrpc":"2.0","id":1}');
    expect(second[0]?.parsedOk).toBe(true);
    expect(second[0]?.atEof).toBe(false);
  });

  test("emits every frame when many arrive in one chunk", () => {
    const observer = createLineObserver();

    const events = observer.push(encode('{"a":1}\n{"b":2}\n{"c":3}\n'));

    expect(events.map((event) => event.text)).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
    expect(observer.counters().lines).toBe(3);
  });

  test("keeps the carriage return of a CRLF frame and still parses it", () => {
    const observer = createLineObserver();

    const events = observer.push(encode('{"a":1}\r\n'));

    expect(events[0]?.text).toBe('{"a":1}\r');
    expect(events[0]?.parsedOk).toBe(true);
  });

  test("a caller reusing its push buffer cannot corrupt a buffered partial line", () => {
    // Arrange: the pump's scratch-reuse contract — the observer's view is
    // valid only until push() returns.
    const observer = createLineObserver();
    const scratch = encode('{"first":');

    // Act: push, then clobber the same buffer and push again.
    observer.push(scratch);
    scratch.fill(0x21); // "!" — a reused buffer full of new bytes
    const events = observer.push(encode("1}\n"));

    // Assert: the buffered head survived the clobber.
    expect(events[0]?.text).toBe('{"first":1}');
    expect(events[0]?.parsedOk).toBe(true);
  });

  test("blank and whitespace-only lines produce no events and count nothing", () => {
    const observer = createLineObserver();

    const events = observer.push(encode("\n  \n\t\n"));

    expect(events).toEqual([]);
    expect(observer.counters().lines).toBe(0);
    expect(observer.counters().unparseable).toBe(0);
  });
});

describe("unparseable lines are counted, never judged", () => {
  test("invalid JSON is an event with parsedOk false and one unparseable count", () => {
    const observer = createLineObserver();

    const events = observer.push(encode("this is not json\n"));

    expect(events[0]?.parsedOk).toBe(false);
    expect(observer.counters().unparseable).toBe(1);
  });

  test("invalid UTF-8 never throws — the decode is lossy on the copy only", () => {
    const observer = createLineObserver();

    const events = observer.push(new Uint8Array([0xff, 0xfe, 0x80, 0x41, 0x0a]));

    expect(events).toHaveLength(1);
    expect(events[0]?.parsedOk).toBe(false);
  });

  test("binary garbage with embedded newlines is observed without throwing", () => {
    const observer = createLineObserver();
    const garbage = new Uint8Array(512);
    for (let i = 0; i < garbage.length; i += 1) garbage[i] = i % 256;

    expect(() => observer.push(garbage)).not.toThrow();
    expect(observer.counters().bytes).toBe(512);
  });
});

describe("oversized lines: counted, copy dropped, memory bounded", () => {
  const SMALL_CAP = 64;

  test("a line past the cap becomes an oversized event with its byte count", () => {
    const observer = createLineObserver(SMALL_CAP);

    const events = observer.push(encode(`${"x".repeat(200)}\n`));

    expect(events[0]?.kind).toBe("oversized");
    expect(events[0]?.bytes).toBe(200);
    expect(observer.counters().oversized).toBe(1);
  });

  test("the buffer high-water mark never exceeds the cap", () => {
    const observer = createLineObserver(SMALL_CAP);

    observer.push(encode("x".repeat(40)));
    observer.push(encode("y".repeat(40)));
    observer.push(encode("z".repeat(500)));
    observer.push(encode("\n"));

    expect(observer.counters().peakBufferedBytes).toBeLessThanOrEqual(SMALL_CAP);
    expect(observer.counters().oversized).toBe(1);
  });

  test("a 10 MB single line stays bounded at the default cap", () => {
    // Arrange: §4.2 layer 1's torture case, pushed in 64 KiB chunks.
    const observer = createLineObserver();
    const chunk = new Uint8Array(65_536).fill(0x41);
    const TEN_MB = 10 * 1024 * 1024;

    // Act
    for (let sent = 0; sent < TEN_MB; sent += chunk.byteLength) {
      observer.push(chunk);
    }
    const events = observer.push(encode("\n"));

    // Assert
    expect(events[0]?.kind).toBe("oversized");
    expect(observer.counters().oversized).toBe(1);
    expect(observer.counters().peakBufferedBytes).toBeLessThanOrEqual(
      ACP_MAX_PARSE_LINE_BYTES,
    );
  });

  test("the line after an oversized one parses normally again", () => {
    const observer = createLineObserver(SMALL_CAP);

    observer.push(encode(`${"x".repeat(200)}\n`));
    const events = observer.push(encode('{"ok":true}\n'));

    expect(events[0]?.kind).toBe("line");
    expect(events[0]?.parsedOk).toBe(true);
  });
});

describe("stream end", () => {
  test("end() flushes a trailing partial frame with atEof set", () => {
    const observer = createLineObserver();

    observer.push(encode('{"jsonrpc":"2.0","never":'));
    const events = observer.end();

    expect(events).toHaveLength(1);
    expect(events[0]?.atEof).toBe(true);
    expect(events[0]?.parsedOk).toBe(false);
  });

  test("end() after a clean newline has nothing to say", () => {
    const observer = createLineObserver();

    observer.push(encode('{"a":1}\n'));

    expect(observer.end()).toEqual([]);
  });

  test("the bytes counter is total bytes pushed, newlines included", () => {
    const observer = createLineObserver();

    observer.push(encode('{"a":1}\n{"b":'));
    observer.push(encode("2}\n"));

    expect(observer.counters().bytes).toBe('{"a":1}\n{"b":'.length + "2}\n".length);
  });
});
