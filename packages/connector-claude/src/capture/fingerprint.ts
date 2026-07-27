import {
  FINGERPRINT_HASH_CHARS,
  FINGERPRINT_KEEP_CHARS,
  FINGERPRINT_MIN_CHARS,
} from "../constants.ts";
import { containsSecret } from "./secret-scan.ts";

/**
 * Order matters: every rule consumes text the next rule would otherwise match
 * (paths before line numbers, timestamps before bare integers).
 */
const NORMALIZERS: readonly (readonly [RegExp, string])[] = [
  [/\r\n/g, "\n"],
  [/\x1b\[[0-9;]*[A-Za-z]/g, ""],
  [/[A-Za-z]:\\[^\s"']+/g, "<path>"],
  [/(?:\/[\w.+@-]+){2,}/g, "<path>"],
  [
    /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?/gi,
    "<ts>",
  ],
  [/\d{2}:\d{2}:\d{2}(?:\.\d+)?/g, "<ts>"],
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>"],
  [/0x[0-9a-f]+/gi, "<hex>"],
  [/\b[0-9a-f]{8,}\b/gi, "<hex>"],
  [/:\d+(?::\d+)?/g, "<line>"],
  [/line \d+/gi, "<line>"],
  [/\d{3,}/g, "<n>"],
];

/**
 * Strips everything run-specific (paths, timestamps, pids, addresses) so the
 * same failure on two machines normalizes to the same string.
 */
export const normalizeFailureText = (raw: string): string => {
  const stripped = NORMALIZERS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    raw,
  );
  return stripped
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(-FINGERPRINT_KEEP_CHARS);
};

const sha256Hex = (input: string): string =>
  new Bun.CryptoHasher("sha256").update(input).digest("hex");

/**
 * Deterministic error fingerprint (DESIGN.md §3 Tier 0). Returns null when the
 * output carries no signal or carries a secret — never a redacted derivative.
 */
export const fingerprint = (raw: string): string | null => {
  if (containsSecret(raw)) {
    return null;
  }
  const normalized = normalizeFailureText(raw);
  if (normalized.length < FINGERPRINT_MIN_CHARS) {
    return null;
  }
  return `sha256:${sha256Hex(normalized).slice(0, FINGERPRINT_HASH_CHARS)}`;
};
