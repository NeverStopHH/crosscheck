/**
 * The Block-5 line pump (src/inject/line-pump.ts): the injection-active
 * client→agent forward path. The bar is the transparency suite's, hash both
 * sides: with a handler that never injects, every torture stream must come
 * out BYTE-IDENTICAL — that is the "no config → unchanged wire" half of
 * prime directive 1, proven at the pump layer (the --no-inject half never
 * reaches this pump at all; proxy-e2e proves that separately).
 */
import { describe, expect, test } from "bun:test";

import { pumpLines } from "../src/inject/line-pump.ts";
import type { LineHandler } from "../src/inject/line-pump.ts";
import type { ByteSink } from "../src/pump.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const encode = (text: string): Uint8Array => encoder.encode(text);

const sha256 = (bytes: Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

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
        parts.push(chunk.slice());
      },
    },
  };
};

const chunked = (bytes: Uint8Array, width: number): Uint8Array[] => {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += width) {
    chunks.push(bytes.subarray(offset, Math.min(offset + width, bytes.byteLength)));
  }
  return chunks;
};

const NEVER_INJECT: LineHandler = () => Promise.resolve(null);

const frame = (index: number): string =>
  `{"jsonrpc":"2.0","id":${index},"method":"session/update","params":{"seq":${index},"note":"héllo→∎"}}\n`;

describe("byte transparency with a never-injecting handler (hash both sides)", () => {
  test("split writes landing mid-JSON-frame and mid-UTF-8-character", async () => {
    // Arrange
    const wire = encode(frame(1) + frame(2) + frame(3) + frame(4) + frame(5));
    const { sink, parts } = collectingSink();

    // Act
    const outcome = await pumpLines(toSource(chunked(wire, 7)), sink, NEVER_INJECT);

    // Assert
    expect(sha256(concat(parts))).toBe(sha256(wire));
    expect(outcome.linesHandled).toBe(5);
    expect(outcome.linesReplaced).toBe(0);
  });

  test("a 10 MB single line forwards byte-identically past the cap, unhandled", async () => {
    const TEN_MB = 10 * 1024 * 1024;
    const line = new Uint8Array(TEN_MB + 1).fill(0x41);
    line[TEN_MB] = 0x0a;
    const { sink, parts } = collectingSink();

    const outcome = await pumpLines(toSource(chunked(line, 65_536)), sink, NEVER_INJECT);

    expect(sha256(concat(parts))).toBe(sha256(line));
    // The oversized line never reached the handler — nothing injectable is
    // that large, and the copy cost stays bounded.
    expect(outcome.linesHandled).toBe(0);
  });

  test("binary garbage, CRLF lines and a trailing partial frame at EOF", async () => {
    const garbage = new Uint8Array(512).map((_, index) => (index * 7) % 256);
    const wire = concat([
      encode('{"jsonrpc":"2.0","id":1,"method":"x"}\r\n'),
      garbage,
      encode("\n"),
      encode('{"jsonrpc":"2.0","id":2,"method":"y"}\n'),
      encode('{"partial":tru'), // EOF mid-frame
    ]);
    const { sink, parts } = collectingSink();

    const outcome = await pumpLines(toSource(chunked(wire, 13)), sink, NEVER_INJECT);

    expect(sha256(concat(parts))).toBe(sha256(wire));
    expect(outcome.writeError).toBeUndefined();
  });

  test("many messages per chunk stay in order", async () => {
    const wire = encode(
      Array.from({ length: 200 }, (_, index) => frame(index)).join(""),
    );
    const { sink, parts } = collectingSink();

    await pumpLines(toSource([wire]), sink, NEVER_INJECT);

    expect(decoder.decode(concat(parts))).toBe(decoder.decode(wire));
  });
});

describe("the replacement path (the two write points ride this)", () => {
  test("a replaced line carries the replacement; neighbors stay verbatim", async () => {
    const wire = encode(frame(1) + '{"id":2,"method":"session/new"}\n' + frame(3));
    const { sink, parts } = collectingSink();
    const handler: LineHandler = (text) =>
      Promise.resolve(text.includes("session/new") ? '{"id":2,"replaced":true}' : null);

    const outcome = await pumpLines(toSource([wire]), sink, handler);

    const output = decoder.decode(concat(parts));
    expect(output).toBe(frame(1) + '{"id":2,"replaced":true}\n' + frame(3));
    expect(outcome.linesReplaced).toBe(1);
  });

  test("a CRLF-terminated line keeps its CRLF when replaced", async () => {
    const wire = encode('{"id":1,"method":"session/new"}\r\n');
    const { sink, parts } = collectingSink();

    await pumpLines(toSource([wire]), sink, () => Promise.resolve('{"r":1}'));

    expect(decoder.decode(concat(parts))).toBe('{"r":1}\r\n');
  });

  test("a throwing handler forwards the ORIGINAL bytes — fail open, counted", async () => {
    const wire = encode(frame(1) + frame(2));
    const { sink, parts } = collectingSink();
    let calls = 0;
    const handler: LineHandler = () => {
      calls += 1;
      throw new Error("handler bug");
    };

    const outcome = await pumpLines(toSource([wire]), sink, handler);

    expect(sha256(concat(parts))).toBe(sha256(wire));
    expect(calls).toBe(2);
    expect(outcome.handlerErrors).toBe(2);
  });

  test("ORDER: a slow decision on line 1 cannot be overtaken by line 2", async () => {
    const wire = encode(frame(1) + frame(2));
    const { sink, parts } = collectingSink();
    const handler: LineHandler = async (text) => {
      if (text.includes('"id":1')) {
        await new Promise((done) => {
          setTimeout(done, 30);
        });
        return '{"held":1}';
      }
      return null;
    };

    await pumpLines(toSource(chunked(wire, 9)), sink, handler);

    expect(decoder.decode(concat(parts))).toBe('{"held":1}\n' + frame(2));
  });
});
