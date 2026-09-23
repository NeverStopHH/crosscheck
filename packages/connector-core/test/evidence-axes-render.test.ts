/**
 * The evidence-axes clause (1.0 spec 08 §3.1, §5) — two labels beside every
 * confidence the product prints, and no untrusted slot on any of them.
 *
 * WHY THIS FILE IS THE `evidence-axes-clause` SURFACE'S `corpusCoveredBy`.
 * §5's claim is that the clause carries nothing author-written: enum values,
 * renderer-owned literals, an age derived from a parsed instant, and a sha
 * behind a hex character class. That is exactly the kind of claim a reader
 * should not take on trust — `observedAt` and `verifiedAtCommit` are STRINGS
 * THE HUB SENT, and a renderer printing them through would put hub-chosen text
 * on every answer surface in the product. So the whole injection corpus is
 * planted in both, under the same character invariants the briefing, MCP and
 * coverage corpora use.
 *
 * The second half of the file is about the ENUMS: every member of every axis
 * must have a sentence, and the weak rungs must not read like clean bills of
 * health. A missing sentence is a type error by construction, but a member
 * that renders as an empty clause would slip past the compiler, so it is
 * asserted here too.
 */
import { describe, expect, test } from "bun:test";

import {
  EVIDENCE_SUPPORT,
  EVIDENCE_SUPPORT_REASONS,
  EVIDENCE_WHO,
} from "@crosscheck/schema";
import type { EvidenceAxes } from "@crosscheck/schema";

import { SHORT_SHA_CHARS, axesClause } from "../src/evidence/render.ts";
import { INJECTION_CORPUS } from "./fixtures/injection-corpus.ts";
import { assertUntrustedCharacters } from "./fixtures/untrusted-invariants.ts";

const NOW = new Date("2026-07-24T12:00:00.000Z");
const OBSERVED = "2026-07-21T12:00:00.000Z";
const COMMIT = "a1b2c3d4e5f6";

const axes = (overrides: Partial<EvidenceAxes> = {}): EvidenceAxes => ({
  who: "agent_derived",
  support: "unsupported",
  supportReason: "no_verification_ref",
  observedAt: null,
  verifiedAtCommit: null,
  ...overrides,
});

describe("the clause carries no untrusted slot", () => {
  test("the whole corpus in observedAt never reaches the output", () => {
    for (const { id, payload: attack } of INJECTION_CORPUS) {
      // Act
      const line = axesClause(
        axes({
          support: "tool_observed",
          supportReason: "ci_observed",
          observedAt: attack,
        }),
        NOW,
      );

      // Assert — the sentence survives, the bytes do not. `formatAge` takes a
      // NUMBER, so an unparseable instant loses the age and nothing else.
      expect(line).toContain("an agent recorded this");
      expect(line).not.toContain(attack);
      assertUntrustedCharacters(line, `evidence-axes-clause/${id}`);
    }
  });

  test("the whole corpus in verifiedAtCommit never reaches the output", () => {
    for (const { id, payload: attack } of INJECTION_CORPUS) {
      // Act — this is the one field printed from hub bytes at all, so it is
      // the one that has to hold under every string in the corpus.
      const line = axesClause(
        axes({
          support: "repository_verified",
          supportReason: "red_then_green",
          verifiedAtCommit: attack,
        }),
        NOW,
      );

      // Assert
      expect(line).toContain("it failed before and passes now");
      expect(line).not.toContain(attack);
      assertUntrustedCharacters(line, `evidence-axes-clause/${id}`);
    }
  });

  test("a sha is printed only when it IS one, and only seven characters", () => {
    // Arrange & Act
    const real = axesClause(
      axes({
        support: "repository_verified",
        supportReason: "red_then_green",
        verifiedAtCommit: COMMIT,
      }),
      NOW,
    );
    const notASha = axesClause(
      axes({
        support: "repository_verified",
        supportReason: "red_then_green",
        verifiedAtCommit: "../../etc/passwd",
      }),
      NOW,
    );

    // Assert — hex passes and is cut; anything else is dropped whole rather
    // than sanitized into something that still looks like an identifier.
    expect(real).toContain(COMMIT.slice(0, SHORT_SHA_CHARS));
    expect(real).not.toContain(COMMIT);
    expect(notASha).not.toContain("passwd");
    expect(notASha).toBe(
      "an agent recorded this — it failed before and passes now",
    );
  });

  test("an unparseable instant loses the age and keeps the sentence", () => {
    // Arrange & Act
    const line = axesClause(
      axes({
        support: "tool_observed",
        supportReason: "observed_failure",
        observedAt: "last Tuesday, probably",
      }),
      NOW,
    );

    // Assert — a degradation, never an injection.
    expect(line).toBe(
      "an agent recorded this — a failure was observed; no fix was shown to land",
    );
  });

  test("an age is derived from the instant, not printed from it", () => {
    // Arrange & Act — three days before NOW.
    const line = axesClause(
      axes({
        support: "tool_observed",
        supportReason: "observed_failure",
        observedAt: OBSERVED,
      }),
      NOW,
    );

    // Assert
    expect(line).toContain("(3d ago)");
    expect(line).not.toContain(OBSERVED);
  });
});

describe("every enum member has a sentence", () => {
  test("every support reason renders, and none renders empty", () => {
    for (const reason of EVIDENCE_SUPPORT_REASONS) {
      // Act
      const line = axesClause(axes({ supportReason: reason }), NOW);

      // Assert — a member with no sentence would be a type error at the
      // Record; a member that rendered EMPTY would not, and an absent clause
      // on a weak rung is exactly what lets a reader assume it was checked.
      expect(line.length).toBeGreaterThan(0);
      expect(line).toContain("an agent recorded this");
    }
  });

  test("every who renders, including the one 1.0 cannot produce", () => {
    for (const who of EVIDENCE_WHO) {
      expect(axesClause(axes({ who }), NOW).length).toBeGreaterThan(0);
    }
  });

  test("every support rung renders", () => {
    for (const support of EVIDENCE_SUPPORT) {
      expect(axesClause(axes({ support }), NOW).length).toBeGreaterThan(0);
    }
  });

  test("a member this version has never heard of loses the clause", () => {
    // Arrange — the forward-compatibility case: a newer hub sends a reason
    // this build does not know.
    const fromTheFuture = axes({
      supportReason: "quantum_verified" as EvidenceAxes["supportReason"],
    });

    // Act
    const line = axesClause(fromTheFuture, NOW);

    // Assert — an UNNAMED label is worse than none: it would either print the
    // raw enum value (hub bytes on every surface) or invent a sentence for a
    // rung whose meaning this build does not know.
    expect(line).toBe("");
  });
});

describe("the weak rungs read as weak", () => {
  test("a claim with nothing behind it does not read like a checked one", () => {
    // Arrange & Act — the default state of every claim written before 08.
    const line = axesClause(axes(), NOW);

    // Assert — the sentence has to say the absence out loud. "no check was
    // attached to it" is the whole point of the axis existing.
    expect(line).toBe("an agent recorded this — no check was attached to it");
  });

  test("only red_then_green claims a fix landed", () => {
    // Arrange — the nine other reasons must not contain the verified phrasing,
    // because that phrase is the only one a reader will act on.
    const verified = "failed before and passes now";

    for (const reason of EVIDENCE_SUPPORT_REASONS) {
      // Act
      const line = axesClause(axes({ supportReason: reason }), NOW);

      // Assert
      if (reason === "red_then_green") {
        expect(line).toContain(verified);
      } else {
        expect(line).not.toContain(verified);
      }
    }
  });
});
