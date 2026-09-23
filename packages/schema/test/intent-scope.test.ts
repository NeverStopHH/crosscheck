/**
 * THE CHECKABLE HALF OF A DECLARED INTENT (spec 06 §3.1, §3.3).
 *
 * INT-9 — an uncheckable scope entry is refused AT THE WIRE. Connectors emit
 * exactly two target kinds (`flows/capture-targets.ts`), and `symbol` /
 * `component` are names nothing can ever match — a declared surface no
 * captured event could intersect is a silent absence, not a feature.
 *
 * INT-8 — a summary-only intent still lands. Every field added here is
 * optional, so a connector from before this spec keeps parsing against a hub
 * that knows the new shape and the reverse (`envelope.ts`'s forward-compat
 * rule). A required new field would strand every deployed connector.
 */
import { describe, expect, test } from "bun:test";

import {
  INTENT_SCOPE_KINDS,
  INTENT_SCOPE_ROLES,
  IntentSchema,
  IntentScopeEntrySchema,
  MAX_INTENT_AMEND_REASON_CHARS,
  MAX_INTENT_CHAIN_VERSIONS,
  MAX_INTENT_SCOPE_ENTRIES,
  MAX_PIN_FILES,
  MAX_PIN_PATH_CHARS,
} from "../src/index.ts";

const EPOCH = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

const V0_INTENT = {
  summary: "Map entity ids across the two providers.",
  provenance: "declared",
  confidence: 1,
  capturedAt: "2026-07-24T09:00:00.000Z",
} as const;

describe("INT-9 — an uncheckable scope entry is refused at the wire", () => {
  test("`file` is the only kind an intent may name", () => {
    // Arrange / Act / Assert
    expect(
      IntentScopeEntrySchema.safeParse({ kind: "file", value: "packages/b.ts" })
        .success,
    ).toBe(true);
    for (const kind of ["symbol", "component", "error_fingerprint"]) {
      expect(IntentScopeEntrySchema.safeParse({ kind, value: "x" }).success).toBe(
        false,
      );
    }
    expect(INTENT_SCOPE_KINDS).toEqual(["file"]);
  });

  test("the path bound is the pin registry's, not a second number", () => {
    // Arrange: a second cap on the same thing is a second argument about what
    // a renderable path is.
    expect(MAX_INTENT_SCOPE_ENTRIES).toBe(MAX_PIN_FILES);

    // Act / Assert
    expect(
      IntentScopeEntrySchema.safeParse({
        kind: "file",
        value: "a".repeat(MAX_PIN_PATH_CHARS),
      }).success,
    ).toBe(true);
    expect(
      IntentScopeEntrySchema.safeParse({
        kind: "file",
        value: "a".repeat(MAX_PIN_PATH_CHARS + 1),
      }).success,
    ).toBe(false);
  });

  test("each role is bounded on its own", () => {
    // Arrange
    const entries = (count: number): readonly unknown[] =>
      Array.from({ length: count }, (_unused, index) => ({
        kind: "file",
        value: `packages/f${index}.ts`,
      }));

    // Act / Assert
    expect(
      IntentSchema.safeParse({
        ...V0_INTENT,
        expectedSurface: entries(MAX_INTENT_SCOPE_ENTRIES),
        nonGoals: entries(MAX_INTENT_SCOPE_ENTRIES),
      }).success,
    ).toBe(true);
    expect(
      IntentSchema.safeParse({
        ...V0_INTENT,
        expectedSurface: entries(MAX_INTENT_SCOPE_ENTRIES + 1),
      }).success,
    ).toBe(false);
  });

  test("both roles exist, and `non_goal` is one of them", () => {
    // Arrange / Act / Assert: `role` decides the answer in §3.5 step 6, so an
    // enum that lost `non_goal` would make a violated non-goal indexable as
    // an expectation — the exact inversion 10.4a exists over.
    expect(INTENT_SCOPE_ROLES).toEqual(["expected", "non_goal"]);
  });
});

describe("INT-8 — an unscoped intent still lands", () => {
  test("a v0 summary-only intent parses unchanged", () => {
    // Arrange / Act
    const parsed = IntentSchema.safeParse(V0_INTENT);

    // Assert
    expect(parsed.success).toBe(true);
    expect(parsed.data?.["expectedSurface"]).toBeUndefined();
    expect(parsed.data?.["nonGoals"]).toBeUndefined();
    expect(parsed.data?.["amendsVersion"]).toBeUndefined();
  });

  test("`seq` is 01's PAIR, never a bare integer", () => {
    // Arrange: a bare integer answers confidently from two different counters
    // when a session's epoch restarts, which 01 SEQ-5 exists to refuse.
    // Act / Assert
    expect(
      IntentSchema.safeParse({ ...V0_INTENT, seq: { epoch: EPOCH, n: 5 } })
        .success,
    ).toBe(true);
    expect(IntentSchema.safeParse({ ...V0_INTENT, seq: 5 }).success).toBe(false);
    expect(IntentSchema.safeParse({ ...V0_INTENT, seq: null }).success).toBe(
      true,
    );
  });

  test("the wire refuses neither half of an amendment, and bounds the reason", () => {
    // Arrange: `amendsVersion` is HUB-assigned — a connector cannot learn it
    // without the hub read §6 forbids — so BOTH one-sided shapes are
    // legitimate records. A connector sends a reason with no version; a stored
    // head carries a hub-stamped version with no reason, because the connector
    // that wrote it predates the field. Refusing either here would refuse a
    // real record, and the spool advances its cursor on any 2xx.
    //
    // The rule that an amendment SAY why is enforced in set_intent, which is
    // the only writer that knows it is amending. What stays bounded here is
    // the length, because this sentence lands on a rendered surface.
    // Act / Assert
    expect(
      IntentSchema.safeParse({ ...V0_INTENT, amendsVersion: 1 }).success,
    ).toBe(true);
    expect(
      IntentSchema.safeParse({
        ...V0_INTENT,
        reason: "The provider's id changed under us.",
      }).success,
    ).toBe(true);
    expect(
      IntentSchema.safeParse({
        ...V0_INTENT,
        amendsVersion: 1,
        reason: "a".repeat(MAX_INTENT_AMEND_REASON_CHARS + 1),
      }).success,
    ).toBe(false);
  });

  test("the chain is bounded", () => {
    // Arrange / Act / Assert
    expect(MAX_INTENT_CHAIN_VERSIONS).toBe(20);
  });
});
