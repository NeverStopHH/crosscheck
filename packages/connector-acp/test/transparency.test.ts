/**
 * THE PROOF for Block 3 (design §4.2 layer 1, verdict 2): output bytes ==
 * input bytes exactly — hash both sides — through the real pump loop, in
 * every torture scenario, with the observer attached. And the prime
 * directive's structural half: a crashing, throwing, or buffer-mutating
 * observer changes NOTHING about the forwarded bytes.
 */
import { describe, expect, test } from "bun:test";

import { createLineObserver } from "../src/observer.ts";
import { pumpBytes } from "../src/pump.ts";
import type { ByteSink } from "../src/pump.ts";

const encoder = new TextEncoder();
const encode = (text: string): Uint8Array => encoder.encode(text);

const frame = (index: number): string =>
  `{"jsonrpc":"2.0","id":${index},"method":"session/update","params":{"seq":${index},"note":"héllo→∎"}}\n`;

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
};

const sha256 = (bytes: Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** Chunks arrive on their own microtasks, like a real stream. */
async function* toSource(chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) {
    await Promise.resolve();
    yield chunk;
  }
}

const collectingSink = (): { readonly sink: ByteSink; readonly parts: Uint8Array[] } => {
  const parts: Uint8Array[] = [];
  return {
    parts,
    sink: {
      write(chunk) {
        // Copy at capture time so a later buffer reuse cannot fake equality.
        parts.push(chunk.slice());
      },
    },
  };
};

interface ScenarioOutcome {
  readonly inputHash: string;
  readonly outputHash: string;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly observer: ReturnType<typeof createLineObserver>;
  readonly outcome: Awaited<ReturnType<typeof pumpBytes>>;
}

const runScenario = async (chunks: readonly Uint8Array[]): Promise<ScenarioOutcome> => {
  const { sink, parts } = collectingSink();
  const observer = createLineObserver();
  const outcome = await pumpBytes(toSource(chunks), sink, (copy) => {
    observer.push(copy);
  });
  const input = concat(chunks);
  const output = concat(parts);
  return {
    inputHash: sha256(input),
    outputHash: sha256(output),
    inputBytes: input.byteLength,
    outputBytes: output.byteLength,
    observer,
    outcome,
  };
};

/** Cuts one byte buffer into fixed-width chunks. */
const chunked = (bytes: Uint8Array, width: number): Uint8Array[] => {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += width) {
    chunks.push(bytes.subarray(offset, Math.min(offset + width, bytes.byteLength)));
  }
  return chunks;
};

describe("§4.2 layer 1: byte transparency, hash both sides", () => {
  test("split writes landing mid-JSON-frame (and mid-UTF-8-character)", async () => {
    // Arrange: 7-byte chunks guarantee cuts inside frames and inside the
    // multi-byte characters the frames carry.
    const wire = encode(frame(1) + frame(2) + frame(3) + frame(4) + frame(5));

    // Act
    const result = await runScenario(chunked(wire, 7));

    // Assert
    expect(result.outputHash).toBe(result.inputHash);
    expect(result.outputBytes).toBe(result.inputBytes);
    expect(result.observer.counters().lines).toBe(5);
    expect(result.observer.counters().unparseable).toBe(0);
  });

  test("a 10 MB single line forwards byte-identically; only the parse copy is dropped", async () => {
    const TEN_MB = 10 * 1024 * 1024;
    const line = new Uint8Array(TEN_MB + 1).fill(0x41);
    line[TEN_MB] = 0x0a;

    const result = await runScenario(chunked(line, 65_536));

    expect(result.outputHash).toBe(result.inputHash);
    expect(result.outputBytes).toBe(TEN_MB + 1);
    expect(result.observer.counters().oversized).toBe(1);
  });

  test("binary garbage interleaved with valid frames", async () => {
    const garbage = new Uint8Array(4096);
    for (let i = 0; i < garbage.length; i += 1) garbage[i] = (i * 7) % 256;
    const chunks = [encode(frame(1)), garbage, encode(frame(2)), garbage.slice(0, 100)];

    const result = await runScenario(chunks);

    expect(result.outputHash).toBe(result.inputHash);
    expect(result.outcome.sourceError).toBeUndefined();
    expect(result.outcome.writeError).toBeUndefined();
  });

  test("agent crash mid-frame: the partial tail is forwarded verbatim", async () => {
    const chunks = [encode(frame(1)), encode('{"jsonrpc":"2.0","id":2,"result":{"hal')];

    const result = await runScenario(chunks);

    expect(result.outputHash).toBe(result.inputHash);
    const tail = result.observer.end();
    expect(tail[0]?.atEof).toBe(true);
  });

  test("slow trickle: one byte per chunk", async () => {
    const wire = encode(frame(42));

    const result = await runScenario(chunked(wire, 1));

    expect(result.outputHash).toBe(result.inputHash);
    expect(result.observer.counters().lines).toBe(1);
    expect(result.observer.counters().unparseable).toBe(0);
  });

  test("a hundred frames in one chunk", async () => {
    let text = "";
    for (let i = 0; i < 100; i += 1) text += frame(i);

    const result = await runScenario([encode(text)]);

    expect(result.outputHash).toBe(result.inputHash);
    expect(result.observer.counters().lines).toBe(100);
  });

  test("CRLF frames and invalid UTF-8 interleaved", async () => {
    const invalid = new Uint8Array([0x7b, 0xff, 0xfe, 0x80, 0x7d, 0x0a]);
    const chunks = [encode('{"a":1}\r\n'), invalid, encode('{"b":2}\r\n')];

    const result = await runScenario(chunks);

    expect(result.outputHash).toBe(result.inputHash);
    expect(result.observer.counters().unparseable).toBe(1);
  });

  test("simultaneous bidirectional flood: both directions hash-equal", async () => {
    // Arrange: two pumps in flight at once, the schedulers interleaving on
    // every chunk — shared state or cross-talk would corrupt one side.
    const c2aChunks = Array.from({ length: 500 }, (_, i) => encode(frame(i)));
    const a2cChunks = Array.from({ length: 500 }, (_, i) => encode(frame(1000 + i)));

    // Act
    const [c2a, a2c] = await Promise.all([
      runScenario(c2aChunks),
      runScenario(a2cChunks),
    ]);

    // Assert
    expect(c2a.outputHash).toBe(c2a.inputHash);
    expect(a2c.outputHash).toBe(a2c.inputHash);
    expect(c2a.inputHash).not.toBe(a2c.inputHash);
  });
});

describe("the prime directive: the observer cannot touch the forward path", () => {
  test("an observer that throws on every chunk changes nothing about the bytes", async () => {
    // Arrange
    const chunks = [encode(frame(1)), encode(frame(2)), encode(frame(3))];
    const { sink, parts } = collectingSink();

    // Act
    const outcome = await pumpBytes(toSource(chunks), sink, () => {
      throw new Error("hostile observer");
    });

    // Assert: bytes identical, failure counted, pump alive to the end.
    expect(sha256(concat(parts))).toBe(sha256(concat(chunks)));
    expect(outcome.observerErrors).toBe(3);
    expect(outcome.writeError).toBeUndefined();
    expect(outcome.sourceError).toBeUndefined();
  });

  test("an observer that mutates its chunk corrupts only its own copy", async () => {
    // Arrange: the sink defers its copy to the write's completion, so a
    // shared buffer would be observably corrupted by the zero-fill below.
    const chunks = [encode(frame(1)), encode(frame(2))];
    const parts: Uint8Array[] = [];
    const sink: ByteSink = {
      write(chunk) {
        return Promise.resolve().then(() => {
          parts.push(chunk.slice());
        });
      },
    };

    // Act
    await pumpBytes(toSource(chunks), sink, (copy) => {
      copy.fill(0);
    });

    // Assert
    expect(sha256(concat(parts))).toBe(sha256(concat(chunks)));
  });

  test("a sink failure stops the pump and is reported, never thrown", async () => {
    // Arrange
    const chunks = [encode(frame(1)), encode(frame(2)), encode(frame(3))];
    let written = 0;
    const sink: ByteSink = {
      write(chunk) {
        if (written === 2) throw new Error("EPIPE");
        written += chunk.byteLength > 0 ? 1 : 0;
      },
    };

    // Act
    const outcome = await pumpBytes(toSource(chunks), sink);

    // Assert
    expect(outcome.writeError).toBeInstanceOf(Error);
    expect(outcome.bytesForwarded).toBe(chunks[0]!.byteLength + chunks[1]!.byteLength);
  });

  test("an async sink is awaited chunk by chunk — order preserved under backpressure", async () => {
    // Arrange: each write resolves a microtask later; unawaited writes would
    // let the loop race ahead and interleave the completion order.
    const chunks = Array.from({ length: 50 }, (_, i) => encode(frame(i)));
    const parts: Uint8Array[] = [];
    const sink: ByteSink = {
      write(chunk) {
        return Promise.resolve().then(() => {
          parts.push(chunk.slice());
        });
      },
    };

    // Act
    const outcome = await pumpBytes(toSource(chunks), sink);

    // Assert
    expect(sha256(concat(parts))).toBe(sha256(concat(chunks)));
    expect(outcome.bytesForwarded).toBe(concat(chunks).byteLength);
  });
});
