/**
 * THE DRAFT-KIND REGISTRY (human provenance §4, §6): every kind registers how
 * it is applied, when a draft of it is live, and what confirming it needs. A
 * batch carrying any privileged kind needs a passkey past its cool-off; one
 * nobody can read is treated as privileged — the refusal side.
 */
import { describe, expect, test } from "bun:test";
import { DRAFT_KINDS } from "@crosscheck/schema";

import { createBatchStore } from "../src/services/confirmation-batch.ts";
import { DRAFT_KIND_REGISTRY, batchAuthority } from "../src/services/draft-kinds.ts";
import { confirmAuthorityOf } from "../src/routes/ui-ceremony-confirm.ts";

describe("the draft-kind registry", () => {
  test("every draft kind is registered, with an apply, a liveness and an authority", () => {
    // Assert
    expect(Object.keys(DRAFT_KIND_REGISTRY).sort()).toEqual([...DRAFT_KINDS].sort());
    for (const kind of DRAFT_KINDS) {
      const spec = DRAFT_KIND_REGISTRY[kind];
      expect(typeof spec.apply).toBe("function");
      expect(typeof spec.isLive).toBe("function");
      expect(["normal", "privileged"]).toContain(spec.authority);
      expect(typeof spec.retirable).toBe("boolean");
    }
  });

  test("Q19: confirming one's own labels, ratings, pins, mutes and presence-on is a normal action", () => {
    // Assert
    expect(DRAFT_KINDS.map((kind) => [kind, DRAFT_KIND_REGISTRY[kind].authority])).toEqual(
      DRAFT_KINDS.map((kind) => [kind, "normal"]),
    );
  });

  test("a batch is privileged when any one of its kinds is", () => {
    // Assert
    expect(batchAuthority([])).toBe("normal");
    expect(batchAuthority([{ authority: "normal" }, { authority: "normal" }])).toBe("normal");
    expect(batchAuthority([{ authority: "normal" }, { authority: "privileged" }])).toBe("privileged");
  });

  test("a batch the caller cannot read signs nothing on a cooling passkey: unknown is privileged", () => {
    // Arrange
    const batches = createBatchStore(() => 0);

    // Act
    const authority = confirmAuthorityOf(
      batches,
      { developerId: "dev_nick", sessionKey: "session" },
      { action: "confirm_batch", subjectId: "hb_none" },
    );

    // Assert
    expect(authority).toBe("privileged");
  });
});
