/**
 * THE DOCTOR LINES FOR DECLARED CAUSAL GUARANTEES (1.0 spec 01a §5): this
 * connector's declaration table, and how many of the caller's session-kind
 * declarations a row of their own overruled (`declaration_contradicted`).
 * Shared by every host's doctor so the three print one table one way.
 *
 * Counts, enum values and connector names only — nothing here is a string a
 * person or a hub wrote: the table is guarantees/declarations.ts's own data,
 * and the count is a non-negative integer the client schema already refused
 * to read otherwise.
 */
import { declarationRowsFor } from "./declarations.ts";
import type { GuaranteeConnector } from "./declarations.ts";

export interface GuaranteeDoctorLine {
  readonly level: "PASS" | "WARN";
  readonly name: string;
  readonly detail: string;
}

/** `kind state (reason)` per canonical kind, in vocabulary order. */
export const declarationTableText = (connector: GuaranteeConnector): string =>
  declarationRowsFor(connector)
    .map((row) => `${row.kind} ${row.guarantee} (${row.reason})`)
    .join("; ");

/** One line: what this connector's positions can support, per kind (01a §3.6). */
export const declarationDoctorLine = (connector: GuaranteeConnector): GuaranteeDoctorLine => ({
  level: "PASS",
  name: `causal guarantees (${connector})`,
  detail: `what this connector's positions can support, the weakest producing lane deciding each kind: ${declarationTableText(connector)}`,
});

/**
 * The cap's count. NULL is a hub that did not report it (one from before
 * declared guarantees) — "not measured", never zero. Above zero is a WARN:
 * a row of the caller's own session overruled what its connector declared,
 * and every surface already reads that kind as `partial`.
 */
export const contradictionDoctorLine = (contradicted: number | null): GuaranteeDoctorLine => {
  const name = "declaration_contradicted";
  if (contradicted === null) {
    return {
      level: "PASS",
      name,
      detail: "not measured: the hub did not report it, which a hub from before declared guarantees does not",
    };
  }
  if (contradicted === 0) {
    return { level: "PASS", name, detail: "no declaration of your sessions was overruled by a row of its own" };
  }
  const one = contradicted === 1;
  const subject = one ? "1 session-kind declaration" : `${String(contradicted)} session-kind declarations`;
  return {
    level: "WARN",
    name,
    detail: `${subject} of your sessions ${one ? "was" : "were"} overruled by ${one ? "a row" : "rows"} of ${one ? "its" : "their"} own — an upper bound or a withheld position where the connector declared guaranteed — and read partial (declaration_contradicted) on every surface`,
  };
};
