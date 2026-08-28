/**
 * READING A FOREIGN MODEL'S ANSWER (model/parse.ts).
 *
 * The prompts were tuned on a Haiku-class Claude, but CROSSCHECK_SUMMARIZER_CMD
 * has always let an operator put another model behind the same contract — and
 * until this file existed, no test had ever fed the parser an answer shaped
 * the way another model shapes one. Three habits were handled wrong; each has
 * its own case below, named after what it COST rather than after the regex
 * that fixes it.
 *
 * The corpus these ride is shared with the end-to-end contract test
 * (connector-claude/test/foreign-model.test.ts), which drives the same strings
 * through a real spawned binary and a real spool, so the two cannot drift.
 */
import { describe, expect, test } from "bun:test";

import { DERIVED_CONFIDENCE_CAP } from "@crosscheck/schema";

import {
  isNoneAnswer,
  parseSummarizerOutput,
  readModelAnswer,
  stripModelWrapping,
} from "../src/model/parse.ts";
import { FOREIGN_SHAPES } from "./fixtures/foreign-model/corpus.ts";

describe("the foreign-model corpus is read the way the corpus says", () => {
  for (const shape of FOREIGN_SHAPES) {
    test(`${shape.name}: ${shape.why}`, () => {
      const answer = readModelAnswer(shape.stdout);
      if (shape.expect.booked === "none") {
        expect(answer.kind).toBe("none");
        return;
      }
      if (shape.expect.booked === "unreadable") {
        expect(answer).toEqual({ kind: "unreadable", why: shape.expect.why });
        return;
      }
      // A refused answer is a CLAIM at this layer — the gates that refuse it
      // run one step later, on a body this pass has already produced.
      expect(answer.kind).toBe("claim");
      if (answer.kind === "claim" && shape.expect.booked === "draft") {
        expect(answer.draft.body).toBe(shape.expect.body);
        expect(answer.draft.confidence).toBe(shape.expect.confidence);
      }
    });
  }
});

describe("a reasoning model's scratchpad is not its answer", () => {
  test("a draft the model REJECTED in its scratchpad is never returned", () => {
    // Arrange: the model weighs a candidate, discards it, and answers NONE.
    // Before the strip, the brace hunt started at the first `{` ANYWHERE in
    // stdout, so the discarded candidate was returned as the answer — a
    // teammate-visible draft built out of text the model had just refused.
    const stdout =
      '<think>\nA candidate would be {"kind":"decision","body":"Chose the bounded reader over the streaming one","confidence":0.9} — but the slice states no decision.\n</think>\nNONE\n';

    // Act
    const answer = readModelAnswer(stdout);

    // Assert
    expect(answer.kind).toBe("none");
    expect(parseSummarizerOutput(stdout)).toBeNull();
  });

  test("the answer AFTER the scratchpad is still read", () => {
    // The control: stripping must not cost a real answer.
    const answer = readModelAnswer(
      '<think>weighing it up</think>\n{"kind":"decision","body":"Chose the bounded reader over the streaming one","confidence":0.4}',
    );
    expect(answer.kind).toBe("claim");
    if (answer.kind === "claim") {
      expect(answer.draft.body).toContain("bounded reader");
    }
  });

  test("a body that merely QUOTES the tag keeps its text", () => {
    // The strip is anchored to a line start on purpose: reasoning blocks are
    // emitted at a line start, and a quoted tag inside a JSON string is not.
    const answer = readModelAnswer(
      '{"kind":"observation","body":"The <think> tag leaks into the rendered log","confidence":0.2}',
    );
    expect(answer.kind).toBe("claim");
    if (answer.kind === "claim") {
      expect(answer.draft.body).toContain("<think>");
    }
  });

  test("a scratchpad the byte bound cut open leaves nothing, and says so", () => {
    expect(readModelAnswer("<think>\nStill weighing the two readings of")).toEqual({
      kind: "unreadable",
      why: "empty",
    });
  });
});

describe("a polite NONE is still a NONE", () => {
  test("a preamble, a fence and a scratchpad each leave the NONE intact", () => {
    expect(isNoneAnswer("Sure! I read the slice carefully.\n\nNONE\n")).toBe(true);
    expect(isNoneAnswer("```\nNONE\n```\n")).toBe(true);
    expect(isNoneAnswer("<think>no conclusion here</think>\nNONE")).toBe(true);
    expect(isNoneAnswer("NONE\r\n")).toBe(true);
  });

  test("a sentence that merely ENDS in the word is not a NONE", () => {
    // The final-line rule is strict about the line, not about the word: a
    // rule that accepted any line ending in NONE would swallow prose.
    expect(isNoneAnswer("The retry cap check was left as NONE")).toBe(false);
    expect(isNoneAnswer("Actually, on reflection: NONE")).toBe(false);
  });

  test("an answer that contradicts itself resolves to NONE, not to the draft", () => {
    // Dropping a draft is the cheap direction; keeping one the model
    // disowned on its last line is not.
    expect(
      readModelAnswer(
        '{"kind":"decision","body":"Chose the bounded reader over the streaming one","confidence":0.4}\nNONE',
      ).kind,
    ).toBe("none");
  });
});

describe("chatter around the answer does not destroy it", () => {
  test("a closing offer containing a brace still leaves the claim readable", () => {
    // The hunt used to run to the LAST `}` in stdout, so this span covered
    // the answer AND the chatter and parsed as nothing.
    const answer = readModelAnswer(
      '{"kind":"root_cause","body":"The lease is renewed after it expires","confidence":0.4}\nHope that helps — want the {full} breakdown?',
    );
    expect(answer.kind).toBe("claim");
  });

  test("a preamble object that is not a claim is stepped over", () => {
    const answer = readModelAnswer(
      '{"note":"here is my reasoning"}\n{"kind":"root_cause","body":"The lease is renewed after it expires","confidence":0.4}',
    );
    expect(answer.kind).toBe("claim");
    if (answer.kind === "claim") {
      expect(answer.draft.body).toContain("lease");
    }
  });

  test("a brace inside the body does not end the object early", () => {
    const answer = readModelAnswer(
      '{"kind":"observation","body":"The map {a: 1} is rebuilt on every read","confidence":0.2}',
    );
    expect(answer.kind).toBe("claim");
    if (answer.kind === "claim") {
      expect(answer.draft.body).toContain("{a: 1}");
    }
  });

  test("an object cut off mid-string is unreadable, never half a claim", () => {
    expect(readModelAnswer('{"kind":"root_cause","body":"The lease is ren')).toEqual({
      kind: "unreadable",
      why: "shape",
    });
  });
});

describe("the contract itself is not negotiable", () => {
  test("a foreign model's confidence is clamped to the derived cap", () => {
    const answer = readModelAnswer(
      '```json\n{"kind":"root_cause","body":"The lease is renewed after it expires","confidence":0.9}\n```',
    );
    expect(answer.kind).toBe("claim");
    if (answer.kind === "claim") {
      expect(answer.draft.confidence).toBe(DERIVED_CONFIDENCE_CAP);
    }
  });

  test("an off-schema kind or an over-long body is still refused", () => {
    expect(readModelAnswer('{"kind":"novel_kind","body":"x","confidence":0.4}').kind).toBe(
      "unreadable",
    );
    expect(
      readModelAnswer(`{"kind":"observation","body":"${"x".repeat(401)}"}`).kind,
    ).toBe("unreadable");
  });

  test("printing nothing and printing something unreadable are different facts", () => {
    // Different remedies: one sends a reader to the binary, the other to the
    // model behind it. Folding them would cost the reader the distinction.
    expect(readModelAnswer("")).toEqual({ kind: "unreadable", why: "empty" });
    expect(readModelAnswer("   \n \n")).toEqual({ kind: "unreadable", why: "empty" });
    expect(readModelAnswer("I think the retry cap is the problem.")).toEqual({
      kind: "unreadable",
      why: "shape",
    });
  });

  test("stripping removes packaging and nothing else", () => {
    expect(stripModelWrapping("```json\n{\"a\":1}\n```")).toBe('{"a":1}');
    expect(stripModelWrapping("NONE\r\n")).toBe("NONE");
  });
});
