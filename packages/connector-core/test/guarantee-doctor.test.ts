/**
 * DOCTOR'S TWO GUARANTEE LINES (01a §5): the connector's declaration table,
 * and the count of declarations a row overruled. Enum words and a count —
 * the only things these lines may carry.
 */
import { describe, expect, test } from "bun:test";

import { GUARANTEE_KINDS } from "@crosscheck/schema";

import {
  contradictionDoctorLine,
  declarationDoctorLine,
} from "../src/guarantees/doctor.ts";
import { GUARANTEE_CONNECTORS, declarationRowsFor } from "../src/guarantees/declarations.ts";

describe("the declaration table line", () => {
  test("names every kind with its declared state and reason, for each connector", () => {
    for (const connector of GUARANTEE_CONNECTORS) {
      // Act
      const line = declarationDoctorLine(connector);
      // Assert
      expect(line.name).toBe(`causal guarantees (${connector})`);
      for (const row of declarationRowsFor(connector)) {
        expect(line.detail).toContain(`${row.kind} ${row.guarantee} (${row.reason})`);
      }
      expect(GUARANTEE_KINDS.every((kind) => line.detail.includes(kind))).toBe(true);
    }
  });

  test("Claude Code's table says what its Bash lane costs", () => {
    expect(declarationDoctorLine("claude-code").detail).toContain(
      "file.modified partial (unbracketed_lane)",
    );
  });
});

describe("the declaration_contradicted line", () => {
  test("a hub that did not report the count reads not measured, never zero", () => {
    // Act
    const line = contradictionDoctorLine(null);
    // Assert
    expect(line.level).toBe("PASS");
    expect(line.detail).toContain("not measured");
  });

  test("zero is a pass that says so", () => {
    expect(contradictionDoctorLine(0)).toEqual({
      level: "PASS",
      name: "declaration_contradicted",
      detail:
        "counts your own sessions only, not your team's: no declaration of theirs was overruled by a row of its own",
    });
  });

  test("every count says plainly that it is your own sessions, not the team's (decided by Nick, 2026-10-02)", () => {
    for (const count of [0, 1, 3]) {
      // Act
      const { detail } = contradictionDoctorLine(count);
      // Assert: the scope comes first, before the number a reader might read as the team's.
      expect(detail.startsWith("counts your own sessions only, not your team's:"), detail).toBe(true);
    }
  });

  test("any overruled declaration is a warning that names the count and the cap", () => {
    // Act
    const line = contradictionDoctorLine(3);
    // Assert
    expect(line.level).toBe("WARN");
    expect(line.detail).toContain("3 session-kind declarations");
    expect(line.detail).toContain("partial (declaration_contradicted)");
  });
});
