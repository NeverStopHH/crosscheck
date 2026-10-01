/**
 * COUNTS KEYED BY STRINGS READ BACK FROM FILES (docs/1.0/loss-accounting.md
 * §4.3) — the ledgers' reasons, record kinds and kind:detail keys.
 *
 * OWN PROPERTIES ONLY. A key is whatever a ledger line says, and a line is a
 * file: `(counts[name] ?? 0) + by` with `name` = "constructor" reads
 * `Object.prototype.constructor`, a function, and the sum becomes a STRING —
 * which then travels in the loss report's `kinds`, where the hub's schema
 * takes integers only and refuses the whole session call. Measured on this
 * tree before the fix: two `.drops` lines with reasons `constructor` and
 * `__proto__` produced `kinds.unattributed` = "0function Object() { … }…1".
 */
export type Counts = Readonly<Record<string, number>>;

/** The count under `name`, or 0 — never an inherited member. */
export const countOf = (counts: Counts, name: string): number =>
  Object.hasOwn(counts, name) ? (counts[name] ?? 0) : 0;

/** A new map with `by` added under `name`; the computed key is always an own one. */
export const addCount = (counts: Counts, name: string, by: number): Counts => ({
  ...counts,
  [name]: countOf(counts, name) + by,
});
