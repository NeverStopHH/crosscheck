/**
 * THE DECLARED CAUSAL GUARANTEES (1.0 spec 01a §3.6): the vocabulary a
 * connector states what it COULD observe in, and the fold the hub reads a
 * declaration through. The fold is the contract: a hub older than a value must
 * never read that value as stronger than it is, and a declaration it cannot
 * read is stored as nothing — `undeclared`, never `guaranteed`.
 */
import { describe, expect, test } from "bun:test";

import {
  CAUSAL_GUARANTEES,
  CAUSAL_GUARANTEE_REASONS,
  GUARANTEE_KINDS,
  GUARANTEE_OF_REASON,
  MAX_GUARANTEE_TRIPLES,
  ORDER_REASONS,
  ORDER_REASON_STRENGTH,
  foldGuaranteeDeclaration,
  stateOfOrderReason,
  weakerGuarantee,
} from "../src/causal-guarantees.ts";
import { LEDGER_EVENT_KINDS, SESSION_EVENT_KINDS } from "../src/session-event.ts";

describe("the vocabulary, exactly as 01a §3.6 states it", () => {
  test("four states, weakest first", () => {
    expect([...CAUSAL_GUARANTEES]).toEqual(["undeclared", "unavailable", "partial", "guaranteed"]);
  });

  test("nine reasons, each owned by exactly one state", () => {
    // Assert
    expect([...CAUSAL_GUARANTEE_REASONS]).toEqual([
      "bracketed_by_pre_tool",
      "lifecycle",
      "unbracketed_lane",
      "observed_lane_only",
      "derived_after_the_fact",
      "ambiguous_session_possible",
      "no_emitter",
      "not_built",
      "provider_undeclared",
    ]);
    expect(GUARANTEE_OF_REASON).toEqual({
      bracketed_by_pre_tool: "guaranteed",
      lifecycle: "guaranteed",
      unbracketed_lane: "partial",
      observed_lane_only: "partial",
      derived_after_the_fact: "partial",
      ambiguous_session_possible: "partial",
      no_emitter: "unavailable",
      not_built: "unavailable",
      provider_undeclared: "undeclared",
    });
  });

  test("a declaration covers the seven projected kinds and the two ledger kinds", () => {
    expect([...GUARANTEE_KINDS]).toEqual([...SESSION_EVENT_KINDS, ...LEDGER_EVENT_KINDS]);
    expect(GUARANTEE_KINDS.length).toBe(9);
  });

  test("the order block's reasons add the three the hub and the reader own, and nothing else", () => {
    expect(ORDER_REASONS.slice(CAUSAL_GUARANTEE_REASONS.length)).toEqual([
      "declaration_contradicted",
      "no_session_in_scope",
      "hub_did_not_report",
    ]);
  });

  test("the weaker of two states is the one earlier in the list, whichever comes first", () => {
    expect(weakerGuarantee("guaranteed", "partial")).toBe("partial");
    expect(weakerGuarantee("unavailable", "partial")).toBe("unavailable");
    expect(weakerGuarantee("undeclared", "guaranteed")).toBe("undeclared");
  });
});

describe("foldGuaranteeDeclaration — folded, never refused, never strengthened", () => {
  test("a coherent triple passes through", () => {
    // Act
    const folded = foldGuaranteeDeclaration([
      { kind: "file.modified", guarantee: "partial", reason: "unbracketed_lane" },
    ]);

    // Assert
    expect(folded).toEqual([
      { kind: "file.modified", guarantee: "partial", reason: "unbracketed_lane" },
    ]);
  });

  test("an unknown reason is read as undeclared, never as the state it came with", () => {
    // Act
    const folded = foldGuaranteeDeclaration([
      { kind: "file.modified", guarantee: "guaranteed", reason: "teleported_before_the_tool" },
    ]);

    // Assert
    expect(folded).toEqual([
      { kind: "file.modified", guarantee: "undeclared", reason: "provider_undeclared" },
    ]);
  });

  test("an unknown state is read as undeclared", () => {
    expect(
      foldGuaranteeDeclaration([{ kind: "tool.failed", guarantee: "certain", reason: "lifecycle" }]),
    ).toEqual([{ kind: "tool.failed", guarantee: "undeclared", reason: "provider_undeclared" }]);
  });

  test("a reason that belongs to another state is read as undeclared, not as either", () => {
    // Arrange: a lane-free reason claimed for the strongest state
    const sent = [{ kind: "claim.created", guarantee: "guaranteed", reason: "no_emitter" }];

    // Act + Assert
    expect(foldGuaranteeDeclaration(sent)).toEqual([
      { kind: "claim.created", guarantee: "undeclared", reason: "provider_undeclared" },
    ]);
  });

  test("the hub's own words are not a connector's to send", () => {
    expect(
      foldGuaranteeDeclaration([
        { kind: "file.modified", guarantee: "partial", reason: "declaration_contradicted" },
      ]),
    ).toEqual([{ kind: "file.modified", guarantee: "undeclared", reason: "provider_undeclared" }]);
  });

  test("an unknown kind is dropped: no question asks about it, so nothing reads it", () => {
    expect(
      foldGuaranteeDeclaration([
        { kind: "thought.had", guarantee: "guaranteed", reason: "lifecycle" },
        { kind: "session.started", guarantee: "guaranteed", reason: "lifecycle" },
      ]),
    ).toEqual([{ kind: "session.started", guarantee: "guaranteed", reason: "lifecycle" }]);
  });

  test("a kind declared twice keeps the weaker of the two, in either order", () => {
    // Arrange
    const strong = { kind: "file.modified", guarantee: "guaranteed", reason: "bracketed_by_pre_tool" };
    const weak = { kind: "file.modified", guarantee: "partial", reason: "unbracketed_lane" };

    // Act + Assert
    for (const sent of [[strong, weak], [weak, strong]]) {
      expect(foldGuaranteeDeclaration(sent)).toEqual([
        { kind: "file.modified", guarantee: "partial", reason: "unbracketed_lane" },
      ]);
    }
  });

  test.each([
    ["not an array", { kind: "file.modified" }],
    ["a string", "guaranteed"],
    ["null", null],
    ["undefined", undefined],
  ] as const)("%s is stored as nothing", (_label, raw) => {
    expect(foldGuaranteeDeclaration(raw)).toEqual([]);
  });

  test("a block longer than the cap is stored as nothing, never cut to its strongest half", () => {
    // Arrange
    const sent = Array.from({ length: MAX_GUARANTEE_TRIPLES + 1 }, () => ({
      kind: "session.started",
      guarantee: "guaranteed",
      reason: "lifecycle",
    }));

    // Act + Assert
    expect(foldGuaranteeDeclaration(sent)).toEqual([]);
  });

  test("a malformed entry is dropped and its neighbours kept", () => {
    expect(
      foldGuaranteeDeclaration([
        "file.modified",
        { kind: "x".repeat(200), guarantee: "partial", reason: "unbracketed_lane" },
        { kind: "session.ended", guarantee: "guaranteed", reason: "lifecycle" },
      ]),
    ).toEqual([{ kind: "session.ended", guarantee: "guaranteed", reason: "lifecycle" }]);
  });

  test("the folded block is in vocabulary order, whatever order it arrived in", () => {
    expect(
      foldGuaranteeDeclaration([
        { kind: "session.ended", guarantee: "guaranteed", reason: "lifecycle" },
        { kind: "session.started", guarantee: "guaranteed", reason: "lifecycle" },
      ]).map((triple) => triple.kind),
    ).toEqual(["session.started", "session.ended"]);
  });
});

describe("a guaranteed reason the kind cannot carry reads undeclared", () => {
  const STRONG_REASONS = CAUSAL_GUARANTEE_REASONS.filter(
    (reason) => GUARANTEE_OF_REASON[reason] === "guaranteed",
  );
  const ADMITTED: readonly (readonly [string, string])[] = [
    ["session.started", "lifecycle"],
    ["session.ended", "lifecycle"],
    ["file.modified", "bracketed_by_pre_tool"],
    ["tool.failed", "bracketed_by_pre_tool"],
  ];
  const isAdmitted = (kind: string, reason: string): boolean =>
    ADMITTED.some(([admittedKind, admittedReason]) => admittedKind === kind && admittedReason === reason);

  test.each([
    // The hub stores every commit row observed: no client can bracket one.
    ["commit.observed", "bracketed_by_pre_tool"],
    ["commit.observed", "lifecycle"],
    // `lifecycle` is n = 0 or the terminal position: only the two session kinds have one.
    ["file.modified", "lifecycle"],
    ["tool.failed", "lifecycle"],
    // The MCP picker can withhold a claim's or an intent's position.
    ["claim.created", "lifecycle"],
    ["claim.invalidated", "bracketed_by_pre_tool"],
    ["intent.declared", "bracketed_by_pre_tool"],
    ["intent.amended", "lifecycle"],
    // A pre-tool bracket opens around a tool; no tool starts or ends a session.
    ["session.started", "bracketed_by_pre_tool"],
    ["session.ended", "bracketed_by_pre_tool"],
  ] as const)("%s guaranteed / %s is read as undeclared", (kind, reason) => {
    // Act
    const folded = foldGuaranteeDeclaration([{ kind, guarantee: "guaranteed", reason }]);

    // Assert
    expect(folded).toEqual([{ kind, guarantee: "undeclared", reason: "provider_undeclared" }]);
  });

  test("across every kind and every strong reason, only the four admitted pairs stay guaranteed", () => {
    for (const kind of GUARANTEE_KINDS) {
      for (const reason of STRONG_REASONS) {
        // Act
        const [folded] = foldGuaranteeDeclaration([{ kind, guarantee: "guaranteed", reason }]);

        // Assert
        expect(folded?.guarantee, `${kind} / ${reason}`).toBe(
          isAdmitted(kind, reason) ? "guaranteed" : "undeclared",
        );
      }
    }
  });

  test("every kind keeps every weaker reason: the rule can only lower a declaration", () => {
    const weakReasons = CAUSAL_GUARANTEE_REASONS.filter(
      (reason) => GUARANTEE_OF_REASON[reason] !== "guaranteed" && reason !== "provider_undeclared",
    );
    for (const kind of GUARANTEE_KINDS) {
      for (const reason of weakReasons) {
        // Arrange
        const triple = { kind, guarantee: GUARANTEE_OF_REASON[reason], reason };

        // Act + Assert
        expect(foldGuaranteeDeclaration([triple]), `${kind} / ${reason}`).toEqual([triple]);
      }
    }
  });
});

describe("the one strength order every fold resolves ties by", () => {
  test("it lists every order reason exactly once", () => {
    expect([...ORDER_REASON_STRENGTH].sort()).toEqual([...ORDER_REASONS].sort());
  });

  test("a reason never outranks a reason of a stronger state", () => {
    // Arrange
    const ranks = ORDER_REASON_STRENGTH.map((reason) =>
      CAUSAL_GUARANTEES.indexOf(stateOfOrderReason(reason)),
    );
    // Assert: non-decreasing, so ranking by reason alone is ranking by state first.
    expect(ranks).toEqual([...ranks].sort((left, right) => left - right));
  });

  test("a contradicted declaration is partial and the weakest partial there is", () => {
    // Arrange
    const firstPartial = ORDER_REASON_STRENGTH.findIndex(
      (reason) => stateOfOrderReason(reason) === "partial",
    );
    // Assert
    expect(stateOfOrderReason("declaration_contradicted")).toBe("partial");
    expect(ORDER_REASON_STRENGTH[firstPartial]).toBe("declaration_contradicted");
  });

  test("the reading side's own reasons are undeclared", () => {
    expect(stateOfOrderReason("no_session_in_scope")).toBe("undeclared");
    expect(stateOfOrderReason("hub_did_not_report")).toBe("undeclared");
  });

  test("the summarizer's lane is weaker than the MCP picker's (01a §3.6)", () => {
    expect(ORDER_REASON_STRENGTH.indexOf("derived_after_the_fact")).toBeLessThan(
      ORDER_REASON_STRENGTH.indexOf("ambiguous_session_possible"),
    );
  });
});
