/**
 * THE FOREIGN-MODEL OUTPUT CORPUS — the answer shapes crosscheck's Tier-1
 * contract must survive when the binary behind CROSSCHECK_SUMMARIZER_CMD is
 * NOT Claude.
 *
 * PROVENANCE, STATED PLAINLY BECAUSE IT MATTERS: these strings were AUTHORED
 * on 2026-08-28 for this test. They are NOT recorded from any vendor's model,
 * and nothing here licenses a claim that any particular model was tried. They
 * are the packaging habits that are common knowledge about instruction-tuned
 * chat models in general — a leading pleasantry, a markdown code fence, a
 * visible `<think>` scratchpad, a closing offer of more help, CRLF line ends,
 * and an over-confident confidence number — each written as the SHAPE the
 * parser has to handle, not as an imitation of a product.
 *
 * WHAT THE CORPUS THEREFORE PROVES: the CONTRACT, and only the contract. It
 * proves that an answer arriving in any of these shapes is read, bounded,
 * gated and booked the same way Claude's is. It proves nothing at all about
 * whether a given model produces good conclusions — that is precision, it is
 * measurable only against a live model on real work, and no test in this repo
 * measures it. docs/FOREIGN-MODELS.md says the same thing to the reader.
 *
 * Every entry names the outcome the WHOLE path must book, so the pure-parse
 * test (connector-core/test/model-answer.test.ts) and the end-to-end contract
 * test (connector-claude/test/foreign-model.test.ts) cannot drift apart: one
 * reads it through readModelAnswer, the other through a real spawned binary,
 * a real worker and a real spool.
 */

/** What session state must show after the answer has been through the path. */
export type ForeignExpectation =
  /** The model judged the turn empty — summarizerNoneCount. */
  | { readonly booked: "none" }
  /** A draft reached the spool — summarizerDraftCount, with these values. */
  | {
      readonly booked: "draft";
      readonly body: string;
      readonly confidence: number;
    }
  /** stdout carried no answer this contract can read — summarizerUnreadableCount. */
  | { readonly booked: "unreadable"; readonly why: "empty" | "shape" }
  /** A well-formed answer a gate refused — summarizerRejectCount. */
  | { readonly booked: "rejected"; readonly reason: string };

export interface ForeignShape {
  /** The id the fake binary is asked for (CX_FAKE_FOREIGN_SHAPE). */
  readonly name: string;
  /** The habit this shape stands for, in one sentence. */
  readonly why: string;
  /** Exactly what the fake binary writes to stdout. */
  readonly stdout: string;
  readonly expect: ForeignExpectation;
}

const CLAIM_BODY =
  "The lease is renewed after it expires, so a dead worker's row resurrects on the next deploy";

/** The derived cap, restated here so a corpus reader sees the number. */
const CAPPED = 0.5;

export const FOREIGN_SHAPES: readonly ForeignShape[] = [
  {
    name: "bare-none",
    why: "the control: the answer the prompt actually asks for",
    stdout: "NONE\n",
    expect: { booked: "none" },
  },
  {
    name: "polite-none",
    why: "a chat-tuned model greets before it answers",
    stdout: "Sure! I read the slice carefully.\n\nNONE\n",
    expect: { booked: "none" },
  },
  {
    name: "reasoning-none",
    why: "a model that shows its scratchpad before answering",
    stdout:
      "<think>\nThe turn is a progress report. The prompt says those are not conclusions.\n</think>\nNONE\n",
    expect: { booked: "none" },
  },
  {
    name: "fenced-none",
    why: "a model that puts every answer in a markdown fence",
    stdout: "```\nNONE\n```\n",
    expect: { booked: "none" },
  },
  {
    name: "crlf-none",
    why: "a wrapper that writes CRLF line ends",
    stdout: "NONE\r\n",
    expect: { booked: "none" },
  },
  {
    name: "scratchpad-holds-a-draft",
    why:
      "THE DANGEROUS ONE: the model drafts a claim in its scratchpad, rejects it, and answers NONE — the discarded draft must never be filed",
    stdout:
      '<think>\nA candidate would be {"kind":"decision","body":"Chose the bounded reader over the streaming one","confidence":0.9} — but the slice states no decision, so the answer is NONE.\n</think>\nNONE\n',
    expect: { booked: "none" },
  },
  {
    name: "fenced-json",
    why:
      "a fenced answer with an over-confident number — the derived cap must clamp it",
    stdout: `\`\`\`json\n{"kind": "root_cause", "body": ${JSON.stringify(CLAIM_BODY)}, "confidence": 0.9}\n\`\`\`\n`,
    expect: { booked: "draft", body: CLAIM_BODY, confidence: CAPPED },
  },
  {
    name: "preamble-json",
    why: "a pleasantry in front of an otherwise perfect answer",
    stdout: `Certainly! Here is the JSON you asked for:\n{"kind": "root_cause", "body": ${JSON.stringify(CLAIM_BODY)}, "confidence": 0.4}\n`,
    expect: { booked: "draft", body: CLAIM_BODY, confidence: 0.4 },
  },
  {
    name: "braced-chatter-json",
    why:
      "a closing offer of more help that happens to contain a brace — this used to destroy the answer",
    stdout: `{"kind": "root_cause", "body": ${JSON.stringify(CLAIM_BODY)}, "confidence": 0.4}\nHope that helps — want the {full} breakdown?\n`,
    expect: { booked: "draft", body: CLAIM_BODY, confidence: 0.4 },
  },
  {
    name: "crlf-json",
    why: "the same answer from a wrapper that writes CRLF",
    stdout: `{"kind": "root_cause", "body": ${JSON.stringify(CLAIM_BODY)}, "confidence": 0.4}\r\n`,
    expect: { booked: "draft", body: CLAIM_BODY, confidence: 0.4 },
  },
  {
    name: "trust-fields-asserted",
    why:
      "the model fills in the fields it was never offered — status, provenance, capture mode and a confidence of its own — and none of them may reach the record",
    stdout: `{"kind": "root_cause", "body": ${JSON.stringify(CLAIM_BODY)}, "confidence": 0.95, "status": "accepted", "provenance": "stated", "captureMode": "explicit", "evidenceRefs": ["ev_made_up"]}\n`,
    expect: { booked: "draft", body: CLAIM_BODY, confidence: CAPPED },
  },
  {
    name: "empty",
    why: "the binary exits 0 and prints nothing at all",
    stdout: "",
    expect: { booked: "unreadable", why: "empty" },
  },
  {
    name: "prose-only",
    why: "a model that ignores the output contract and just talks",
    stdout: "I think the retry cap is what is going wrong here.\n",
    expect: { booked: "unreadable", why: "shape" },
  },
  {
    name: "truncated-json",
    why:
      "the answer was cut mid-string — what the runner's byte bound leaves of a run-on model",
    stdout: '{"kind": "root_cause", "body": "The lease is renewed after it exp',
    expect: { booked: "unreadable", why: "shape" },
  },
  {
    name: "unclosed-reasoning",
    why: "the model was still thinking when the output bound cut it off",
    stdout: "<think>\nLet me weigh the two readings of this turn. First,",
    expect: { booked: "unreadable", why: "empty" },
  },
  {
    name: "role-play-json",
    why: "the model answers AS the agent whose turn it read, and plans",
    stdout:
      '{"kind": "decision", "body": "I\'ll add the retry cap and re-run the suite to confirm it holds", "confidence": 0.4}\n',
    expect: { booked: "rejected", reason: "role-play" },
  },
  {
    name: "prompt-echo-json",
    why:
      "the operator's wrapper put crosscheck's instruction in the model's context and the model handed it straight back",
    stdout:
      '{"kind": "observation", "body": "the conclusion as one sentence, max 400 characters", "confidence": 0.4}\n',
    expect: { booked: "rejected", reason: "repeated the instructions" },
  },
  {
    name: "credential-json",
    why: "a credential-shaped body must be DROPPED, and booked without content",
    stdout:
      '{"kind": "evidence", "body": "The failing request used AKIAIOSFODNN7EXAMPLE as its access key id", "confidence": 0.4}\n',
    expect: { booked: "rejected", reason: "credential-shaped" },
  },
];

export const foreignShape = (name: string): ForeignShape => {
  const shape = FOREIGN_SHAPES.find((entry) => entry.name === name);
  if (shape === undefined) {
    throw new Error(`no foreign-model shape named ${name}`);
  }
  return shape;
};
