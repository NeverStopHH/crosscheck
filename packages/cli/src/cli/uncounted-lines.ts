/**
 * CONFIRMED, BUT NOT COUNTED (human provenance §5, review H1). A confirmation
 * counts in a figure only while the passkey that signed it is unrevoked and
 * past its announced cool-off. The reports say both apart from every figure:
 * how many wait for the cool-off and from when they count, and how many a
 * revoked passkey's retraction took out.
 *
 * The instant is the hub's, re-printed by this client as ISO — never the
 * hub's own text — or said to be unreadable.
 */

export interface Uncounted {
  readonly coolingOff?: number | undefined;
  readonly countingFrom?: string | null | undefined;
  readonly retracted?: number | undefined;
}

/** The instant they start counting, as this client prints it. */
const instantOf = (iso: string | null | undefined): string => {
  const ms = iso === null || iso === undefined ? Number.NaN : Date.parse(iso);
  return Number.isNaN(ms) ? "a time this client cannot read" : new Date(ms).toISOString();
};

/** The two lines, each only when its count is above zero. */
export const uncountedLines = (uncounted: Uncounted | undefined, indent: string): readonly string[] => {
  const cooling = uncounted?.coolingOff ?? 0;
  const retracted = uncounted?.retracted ?? 0;
  return [
    ...(cooling > 0
      ? [
          `${indent}${String(cooling)} confirmed, counting from ${instantOf(uncounted?.countingFrom)} — the passkey that confirmed them is still in its cool-off, and revoking it first retracts them`,
        ]
      : []),
    ...(retracted > 0
      ? [`${indent}${String(retracted)} retracted — the passkey that confirmed them was revoked, so they count nowhere`]
      : []),
  ];
};
