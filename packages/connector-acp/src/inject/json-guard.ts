/**
 * Value-preservation guard for the two injection edits (design §2.3 rule 1:
 * the ONLY messages ever re-serialized from a parse). JSON.parse reads every
 * number as an IEEE double, so re-serializing a message whose raw text
 * carries an integer past 2^53 (a JVM/Rust JSON-RPC stack's 64-bit request
 * id) would silently ROUND it — the agent then answers under an id the
 * client never sent, the response never correlates, and session/new hangs
 * forever. A magnitude past double range is worse: it parses to Infinity
 * and re-serializes as `null`.
 *
 * The guard scans the RAW line (post-parse, so the token grammar is known
 * valid) and flags value-LOSSY numbers only:
 *
 *   - integer tokens whose BigInt value differs from their double value
 *     (9007199254740993 → flagged; 9007199254740992 is exact → passes);
 *   - tokens outside double range (1e400 → Infinity → `null`).
 *
 * Value-preserving RESPELLINGS are deliberately NOT flagged: `1.0` → `1`,
 * `1e2` → `100`, `-0` → `0` change spelling, never the double value every
 * JSON consumer reads (RFC 8259's interop baseline) — and flagging spelling
 * would turn injection off for whole client classes (Python's json spells
 * floats `1.0`). Two normalizations ride the same rationale and are
 * accepted, documented here rather than guarded: duplicate object keys
 * collapse to last-wins (RFC 8259 names-SHOULD-be-unique; reader behavior
 * is unpredictable either way), and integer-like keys may reorder (object
 * member order is semantically insignificant).
 */

/** Every integer of at most 15 digits is exactly representable in a double. */
const MAX_EXACT_INTEGER_DIGITS = 15;

/** A number token spelling an integer directly — the only BigInt-comparable form. */
const INTEGER_TOKEN = /^-?\d+$/;

/** Characters that may continue a JSON number token once one has started. */
const NUMBER_CONTINUATION = /[\d.eE+-]/;

/** True when re-serializing this one token would change its VALUE. */
const isLossyNumber = (token: string): boolean => {
  const value = Number(token);
  if (!Number.isFinite(value)) {
    // Past double range: JSON.stringify(Infinity) is "null".
    return true;
  }
  if (!INTEGER_TOKEN.test(token)) {
    // Fraction/exponent spellings re-serialize to the same double value.
    return false;
  }
  const digits = token.startsWith("-") ? token.length - 1 : token.length;
  if (digits <= MAX_EXACT_INTEGER_DIGITS) {
    return false;
  }
  return BigInt(token) !== BigInt(value);
};

/**
 * True when the raw JSON line carries at least one number token whose value
 * cannot survive JSON.parse → JSON.stringify. Callers pass text that has
 * ALREADY parsed as JSON (the injector parses first), so a permissive token
 * scan is sound: outside strings, `-` and digits only ever start a number.
 */
export const hasLossyNumberToken = (json: string): boolean => {
  let isInString = false;
  for (let index = 0; index < json.length; index += 1) {
    const char = json.charAt(index);
    if (isInString) {
      if (char === "\\") {
        index += 1; // the escaped character is data, whatever it is
        continue;
      }
      if (char === '"') {
        isInString = false;
      }
      continue;
    }
    if (char === '"') {
      isInString = true;
      continue;
    }
    if (char === "-" || (char >= "0" && char <= "9")) {
      let end = index + 1;
      while (end < json.length && NUMBER_CONTINUATION.test(json.charAt(end))) {
        end += 1;
      }
      if (isLossyNumber(json.slice(index, end))) {
        return true;
      }
      index = end - 1;
    }
  }
  return false;
};
