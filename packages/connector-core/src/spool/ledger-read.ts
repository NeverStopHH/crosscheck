/**
 * READING A LOSS LEDGER BACK (docs/1.0/loss-accounting.md §4.3, "a line is a
 * file, and files get edited"): the one instant rule every ledger reader
 * shares, so the span the hub receives always parses on its schema.
 *
 * `Date.parse` alone is not that rule. It reads `+275760-09-13T00:00:00.000Z`
 * and `-000001-01-01T00:00:00.000Z`, and `toISOString` writes them back with
 * the extended-year sign — which `z.iso.datetime()` on the hub refuses, so one
 * such line used to refuse every register, heartbeat and end (review M2). An
 * instant counts only inside the four-digit years the wire can carry.
 */

/** 0000-01-01T00:00:00.000Z — the first instant a four-digit ISO year spells. */
const FIRST_WIRE_MS = -62_167_219_200_000;
/** 9999-12-31T23:59:59.999Z — the last. */
const LAST_WIRE_MS = 253_402_300_799_999;

/** The instant's epoch milliseconds, or null when the wire could not carry it. */
export const ledgerMs = (value: string | number | null | undefined): number | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) && ms >= FIRST_WIRE_MS && ms <= LAST_WIRE_MS ? ms : null;
};

/** The instant re-formatted for the wire, or null when it has none the wire takes. */
export const ledgerInstant = (value: string | number | null | undefined): string | null => {
  const ms = ledgerMs(value);
  return ms === null ? null : new Date(ms).toISOString();
};
