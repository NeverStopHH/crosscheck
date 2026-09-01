/**
 * ONE GATE ORDER, FOR EVERY CONNECTOR (Block 1 of connector parity).
 *
 * The order an answer is judged in used to exist only as the statement
 * sequence inside connector-claude's summarizer worker, so a second and a
 * third caller would each have re-derived it — and gotten it subtly wrong,
 * because the order is the whole security argument: the two stdout-only
 * refusals run before the session is re-read, and the secret scan runs
 * before anything can be written anywhere.
 *
 * Every ordering claim below is asserted PAIRWISE on a body that trips both
 * gates at once, which is the only way an order can be proved rather than
 * described. Nothing here talks to a hub or touches disk.
 */
import { describe, expect, test } from "bun:test";

import { DERIVED_CONFIDENCE_CAP } from "@crosscheck/schema";
import { hintBodyHash } from "../src/hints/echo.ts";
import { gateModelAnswer, MODEL_ANSWER_GATE_ORDER } from "../src/model/gates.ts";
import type { ModelClaimContext } from "../src/model/gates.ts";
import {
  REJECTED_HINT_ECHO,
  REJECTED_PROMPT_ECHO,
  REJECTED_ROLE_PLAY,
  REJECTED_SECRET,
} from "../src/model/reject.ts";
import { SUMMARIZER_PROMPT } from "../src/model/runner.ts";

/** The gate pipeline's fixtures: one context, reused. */
const HINT_BODY = "the flush lock is held across the fsync, so writers queue";
const SECRET_BODY = "the deploy key AKIAIOSFODNN7EXAMPLE is still in the repo";

const contextWith = (deliveredHintHashes: readonly string[]): ModelClaimContext => ({
  workContextId: "wc_seam",
  authorSessionId: "cc_seam",
  deliveredHintHashes,
});

const answerOf = (body: string): string =>
  JSON.stringify({ kind: "observation", body, confidence: 0.4 });

const gate = async (
  body: string,
  deliveredHintHashes: readonly string[] = [],
): ReturnType<typeof gateModelAnswer> =>
  gateModelAnswer({
    stdout: answerOf(body),
    prompt: SUMMARIZER_PROMPT,
    now: new Date("2026-08-28T09:00:00.000Z"),
    resolveContext: () => Promise.resolve(contextWith(deliveredHintHashes)),
  });

describe("one gate order, asserted pairwise instead of described", () => {
  test("the documented order is the order the pipeline runs", () => {
    // The header's list is exported so it cannot drift from the code that
    // follows it — a reader and the test read the same array.
    expect(MODEL_ANSWER_GATE_ORDER).toEqual([
      "none-parse",
      "role-play",
      "prompt-echo",
      "delivered-hint-echo",
      "secret-scan",
      "wire-contract",
    ]);
  });

  test("NONE is booked as NONE, and unparseable stays unparseable", async () => {
    // Act
    const none = await gateModelAnswer({
      stdout: "NONE\n",
      prompt: SUMMARIZER_PROMPT,
      now: new Date(),
      resolveContext: () => Promise.resolve(contextWith([])),
    });
    const garbage = await gateModelAnswer({
      stdout: "I am a language model and I cannot",
      prompt: SUMMARIZER_PROMPT,
      now: new Date(),
      resolveContext: () => Promise.resolve(contextWith([])),
    });

    // Assert: a judged-empty turn and a broken runner are different facts.
    expect(none.kind).toBe("none");
    expect(garbage.kind).toBe("unparseable");
  });

  test("role-play beats the delivered-hint echo AND the secret scan", async () => {
    // Arrange: a body that trips all three.
    const body = `I'll rotate ${SECRET_BODY}`;

    // Act
    const outcome = await gate(body, [hintBodyHash(body)]);

    // Assert
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.reason).toBe(REJECTED_ROLE_PLAY);
    }
  });

  test("the prompt echo beats the delivered-hint echo", async () => {
    // Arrange: a long enough slice of the instructions to be a copy.
    const body = "the conclusion as one sentence, max 400 characters";

    // Act
    const outcome = await gate(body, [hintBodyHash(body)]);

    // Assert
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.reason).toBe(REJECTED_PROMPT_ECHO);
    }
  });

  test("the delivered-hint echo beats the secret scan", async () => {
    // Act
    const outcome = await gate(SECRET_BODY, [hintBodyHash(SECRET_BODY)]);

    // Assert
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.reason).toBe(REJECTED_HINT_ECHO);
    }
  });

  test("a credential-shaped answer is dropped, and the reason names no content", async () => {
    // Act
    const outcome = await gate(SECRET_BODY);

    // Assert
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.reason).toBe(REJECTED_SECRET);
      expect(outcome.reason).not.toContain("AKIA");
    }
  });

  test("the two stdout-only gates run BEFORE the session is re-read", async () => {
    // Arrange: a resolver that records whether it was needed.
    let resolved = 0;

    // Act
    const outcome = await gateModelAnswer({
      stdout: answerOf("I'll add the retry cap and re-run the suite"),
      prompt: SUMMARIZER_PROMPT,
      now: new Date(),
      resolveContext: () => {
        resolved += 1;
        return Promise.resolve(contextWith([]));
      },
    });

    // Assert: a role-play answer is booked without a second state read.
    expect(outcome.kind).toBe("rejected");
    expect(resolved).toBe(0);
  });

  test("a session that ended while the model ran abandons the draft, silently", async () => {
    // Act
    const outcome = await gateModelAnswer({
      stdout: answerOf(HINT_BODY),
      prompt: SUMMARIZER_PROMPT,
      now: new Date(),
      resolveContext: () => Promise.resolve(null),
    });

    // Assert
    expect(outcome.kind).toBe("abandoned");
  });

  test("the trust fields are forced by the seam, never chosen by the model", async () => {
    // Arrange: a model asserting status, provenance and a confidence over cap.
    const stdout = JSON.stringify({
      kind: "root_cause",
      body: HINT_BODY,
      confidence: 0.95,
      status: "likely_root_cause",
      provenance: "declared",
      captureMode: "explicit",
    });

    // Act
    const outcome = await gateModelAnswer({
      stdout,
      prompt: SUMMARIZER_PROMPT,
      now: new Date("2026-08-28T09:00:00.000Z"),
      resolveContext: () => Promise.resolve(contextWith([])),
    });

    // Assert: kind and body are the model's; everything carrying TRUST is not.
    expect(outcome.kind).toBe("claim");
    if (outcome.kind === "claim") {
      expect(outcome.claim.kind).toBe("root_cause");
      expect(outcome.claim.body).toBe(HINT_BODY);
      expect(outcome.claim.status).toBe("proposed");
      expect(outcome.claim.provenance).toBe("derived");
      expect(outcome.claim.captureMode).toBe("auto");
      expect(outcome.claim.confidence).toBe(DERIVED_CONFIDENCE_CAP);
      expect(outcome.claim.evidenceRefs).toEqual([]);
      expect(outcome.claim.workContextId).toBe("wc_seam");
      expect(outcome.claim.createdAt).toBe("2026-08-28T09:00:00.000Z");
    }
  });
});
