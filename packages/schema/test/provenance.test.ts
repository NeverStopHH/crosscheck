import { describe, expect, test } from "bun:test";

import {
  DRAFT_KINDS,
  DRAFT_PROVENANCES,
  HUMAN_PROVENANCE,
  LEGACY_PROVENANCE,
  PROVENANCE_CLASSES,
  STORED_JUDGEMENT_PROVENANCES,
  isHumanProvenance,
} from "../src/index.ts";

describe("provenance classes (human provenance §3)", () => {
  test("exactly three classes are ever assigned, with the reviewer's names", () => {
    // Arrange / Act / Assert
    expect([...PROVENANCE_CLASSES]).toEqual([
      "agent_asserted",
      "interactive_terminal_asserted",
      "human_passkey_confirmed",
    ]);
  });

  test("only the passkey class is human", () => {
    // Arrange
    const verdicts = [...PROVENANCE_CLASSES, LEGACY_PROVENANCE].map((value) => [value, isHumanProvenance(value)]);

    // Assert
    expect(verdicts).toEqual([
      ["agent_asserted", false],
      ["interactive_terminal_asserted", false],
      ["human_passkey_confirmed", true],
      ["unknown_legacy", false],
    ]);
    expect(HUMAN_PROVENANCE).toBe("human_passkey_confirmed");
  });

  test("the legacy marker is no class, and an unknown word is never human", () => {
    // Assert
    expect(PROVENANCE_CLASSES as readonly string[]).not.toContain(LEGACY_PROVENANCE);
    expect(isHumanProvenance("human")).toBe(false);
    expect(isHumanProvenance("HUMAN_PASSKEY_CONFIRMED")).toBe(false);
  });

  test("a draft is never human; a stored judgement is human or legacy", () => {
    // Assert
    expect([...DRAFT_PROVENANCES]).toEqual(["agent_asserted", "interactive_terminal_asserted"]);
    expect([...STORED_JUDGEMENT_PROVENANCES]).toEqual(["unknown_legacy", "human_passkey_confirmed"]);
  });

  test("the draft kinds cover every human-only write", () => {
    // Assert
    expect([...DRAFT_KINDS]).toEqual([
      "label",
      "pin_ok",
      "outcome",
      "pin",
      "pin_broke",
      "mute",
      "unmute",
      "presence_on",
    ]);
  });
});
