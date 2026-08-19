/** Pure JSONL helpers shared by the append, flush and reap paths. */
import { Buffer } from "node:buffer";

export const toLines = (raw: string | null): readonly string[] =>
  raw === null
    ? []
    : raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

export const serialize = (lines: readonly string[]): string =>
  lines.length === 0 ? "" : `${lines.join("\n")}\n`;

/**
 * The prefix that ends on a line boundary. A reader can catch an append
 * half-landed; treating those bytes as a line would hand the hub a fragment and
 * move the cursor past the rest of the record that is still on its way.
 */
export const completeLines = (raw: string): string => {
  const end = raw.lastIndexOf("\n");
  return end === -1 ? "" : raw.slice(0, end + 1);
};

export const byteLength = (text: string): number =>
  Buffer.byteLength(text, "utf8");

export const lineTimestampMs = (line: string): number | null => {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const ts = (parsed as Record<string, unknown>)["ts"];
    if (typeof ts !== "string") {
      return null;
    }
    const ms = Date.parse(ts);
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
};