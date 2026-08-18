/**
 * Deterministic flood traffic shared by the fake agent and the backpressure
 * tests. Both sides GENERATE the same bytes from the same chunk index, so the
 * test can compute the expected hash incrementally without ever holding the
 * whole flood in memory — which is the point of the test it feeds.
 */

const FLOOD_PAD = "x".repeat(996);
const LINES_PER_CHUNK = 64;

const encoder = new TextEncoder();

const floodLine = (index: number): string =>
  `${JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: { seq: index, pad: FLOOD_PAD },
  })}\n`;

/** ~64 KiB of NDJSON frames; chunk `i` is identical on every call. */
export const floodChunk = (chunkIndex: number): Uint8Array => {
  let text = "";
  for (let line = 0; line < LINES_PER_CHUNK; line += 1) {
    text += floodLine(chunkIndex * LINES_PER_CHUNK + line);
  }
  return encoder.encode(text);
};

export interface FloodExpectation {
  readonly bytes: number;
  readonly sha256: string;
}

/** What a receiver of `chunks` flood chunks must end up holding. */
export const floodExpectation = (chunks: number): FloodExpectation => {
  const hasher = new Bun.CryptoHasher("sha256");
  let bytes = 0;
  for (let index = 0; index < chunks; index += 1) {
    const chunk = floodChunk(index);
    hasher.update(chunk);
    bytes += chunk.byteLength;
  }
  return { bytes, sha256: hasher.digest("hex") };
};
