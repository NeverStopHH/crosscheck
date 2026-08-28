/**
 * WHAT A MODEL SAID, JUDGED — the ordered pipeline between "the runner came
 * back with stdout" and "a claim exists that may be written down".
 *
 * It used to be the statement sequence inside connector-claude's summarizer
 * worker, which was fine while Claude was the only connector that could
 * spawn a model. It is not fine with three: the ORDER is the whole argument
 * — a second and a third worker re-deriving it would each get a different
 * one, and the difference would be invisible until a body nobody meant to
 * keep had already been written to the spool. One order, one place, and the
 * order is exported as data (MODEL_ANSWER_GATE_ORDER) so this header cannot
 * drift from the code beneath it.
 *
 * BEFORE GATE 1, and not in this file: the runner (runner.ts) resolves the
 * argv — CROSSCHECK_SUMMARIZER_CMD replaces the binary wholesale, otherwise
 * the lean `claude -p` — builds the child environment (the hub key dropped,
 * the CROSSCHECK_SUMMARIZER_CHILD marker set, the parent-session denylist
 * applied by worker-env.ts on the worker that got here), spawns, races the
 * deadline against the read, and cuts stdout at SUMMARIZER_OUTPUT_MAX_BYTES.
 * Everything below starts from that already-bounded string.
 *
 * THE ORDER THIS FILE IMPLEMENTS, exactly:
 *
 *   1. none-parse           — tolerant parse (parse.ts). An explicit NONE is
 *                             its OWN outcome, not "no draft": unparseable
 *                             garbage is a runner problem and folding the
 *                             two would flatter the signal-to-noise figure.
 *                             The BOUNDS are applied here and one step
 *                             earlier: the runner cuts stdout at
 *                             SUMMARIZER_OUTPUT_MAX_BYTES before this sees
 *                             it, the schema refuses a body over
 *                             MAX_CLAIM_BODY_LENGTH, and the model's own
 *                             confidence is clamped to DERIVED_CONFIDENCE_CAP.
 *   2. role-play            — a plan narrated as the agent whose turn was
 *                             read (reject.ts). FIRST of the refusals
 *                             because it needs nothing but the body, and it
 *                             is the shape a tail-degraded slice produces
 *                             most.
 *   3. prompt-echo          — the instructions handed back (reject.ts).
 *                             Also body-only, so it too runs before any
 *                             session fact is read.
 *   ---- the caller's session context is resolved HERE, once, and only if
 *        gates 1-3 let the answer through (see resolveContext below) ----
 *   4. delivered-hint-echo  — a body a teammate hint already delivered
 *                             (hints/echo.ts), which must never come back as
 *                             this session's own independent observation.
 *   5. secret-scan          — credential-shaped bodies are DROPPED, never
 *                             redacted, before anything can leave the
 *                             machine (capture/secret-scan.ts says why).
 *   6. wire-contract        — the trust fields are FORCED (status proposed,
 *                             provenance derived, captureMode auto, no
 *                             evidence) and the result must satisfy
 *                             checkClaim — the same ClaimSchema the MCP
 *                             publish path and the hub apply, derived cap
 *                             included. Neither the model nor the connector
 *                             gets to choose any of it.
 *
 * WHY THE CONTEXT ARRIVES AS A CALLBACK rather than an argument: gates 4-6
 * need session facts that may have CHANGED while the model ran — a hint
 * delivered in the meantime, or a session that ended and has nothing left to
 * attribute to. Reading them up front would both waste the read on the two
 * refusals above and, worse, turn a role-played answer during a session that
 * ended into a silent drop instead of the booked refusal it is today. The
 * callback keeps the read exactly where it was.
 *
 * EVERY REFUSAL IS RETURNED, NEVER SWALLOWED. The caller books it: the fire
 * was paid for out of the developer's own quota, and a fire whose answer
 * nobody kept must be countable or `doctor` reads the whole class as "the
 * runner is broken" (rule 4 — fail open must never mean silently dead). And
 * no reason ever quotes the rejected body, because a reason is printed into
 * a terminal and often into an agent's context.
 *
 * VERIFY: bun -e 'const {MODEL_ANSWER_GATE_ORDER: o} = await import("./packages/connector-core/src/model/gates.ts"); console.log(o.join(" > "))'
 * PRINTS: none-parse > role-play > prompt-echo > delivered-hint-echo > secret-scan > wire-contract
 */
import type { ClaimKind } from "@crosscheck/schema";

import { containsSecret } from "../capture/secret-scan.ts";
import { isEchoOfDeliveredHint } from "../hints/echo.ts";
import { mintClaimId } from "../mcp/tools/shared.ts";
import { checkClaim } from "../mcp/violations.ts";
import { isNoneAnswer, parseSummarizerOutput } from "./parse.ts";
import {
  isPromptEcho,
  isRolePlayAnswer,
  REJECTED_CONTRACT,
  REJECTED_HINT_ECHO,
  REJECTED_PROMPT_ECHO,
  REJECTED_ROLE_PLAY,
  REJECTED_SECRET,
} from "./reject.ts";

/**
 * The gate order as DATA, so the header above and the code below are read
 * from the same array by a reader and by the test that pins it.
 */
export const MODEL_ANSWER_GATE_ORDER = [
  "none-parse",
  "role-play",
  "prompt-echo",
  "delivered-hint-echo",
  "secret-scan",
  "wire-contract",
] as const;

/**
 * The session facts gates 4-6 need, resolved by the CALLER because only the
 * connector knows where its session state lives. `deliveredHintHashes` is
 * whatever that connector counts as delivered — this session's state and the
 * per-repo store, in the Claude worker's case.
 */
export interface ModelClaimContext {
  readonly workContextId: string;
  readonly authorSessionId: string;
  readonly deliveredHintHashes: readonly string[];
}

/**
 * A claim as this pipeline builds it: the model chose `kind` and `body`, and
 * nothing else. Every other field is stamped here (rule 3 — derived stays
 * derived), which is why `status`, `provenance` and `captureMode` are literal
 * types rather than the schema's unions.
 */
export interface DerivedClaim {
  readonly id: string;
  readonly workContextId: string;
  readonly authorSessionId: string;
  readonly kind: ClaimKind;
  readonly body: string;
  readonly status: "proposed";
  /** Already clamped to DERIVED_CONFIDENCE_CAP by the parse. */
  readonly confidence: number;
  readonly captureMode: "auto";
  readonly provenance: "derived";
  readonly evidenceRefs: readonly string[];
  readonly createdAt: string;
}

/**
 * Every way an answer can end. `unparseable` and `abandoned` are DISTINCT
 * from `rejected` on purpose: the first is a runner problem the caller leaves
 * visible as the fires-minus-outcomes remainder, the second is a session that
 * ended while the model ran and has nothing left to attribute a draft to.
 * Only `rejected` and `none` are booked as outcomes of the answer itself.
 */
export type ModelAnswerOutcome =
  | { readonly kind: "none" }
  | { readonly kind: "unparseable" }
  | { readonly kind: "abandoned" }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "claim"; readonly claim: DerivedClaim };

export interface ModelAnswerGateInput {
  /** The runner's stdout, already cut at the runner's byte bound. */
  readonly stdout: string;
  /** The instruction the model was given — gate 3 needs it to spot an echo. */
  readonly prompt: string;
  /** Stamped as the claim's createdAt; the caller reuses it for the envelope. */
  readonly now: Date;
  /** Resolved once, AFTER gates 1-3; null means the session ended meanwhile. */
  readonly resolveContext: () => Promise<ModelClaimContext | null>;
}

const REJECTED = (reason: string): ModelAnswerOutcome => ({
  kind: "rejected",
  reason,
});

export const gateModelAnswer = async (
  input: ModelAnswerGateInput,
): Promise<ModelAnswerOutcome> => {
  // 1. none-parse
  const draft = parseSummarizerOutput(input.stdout);
  if (draft === null) {
    return isNoneAnswer(input.stdout)
      ? { kind: "none" }
      : { kind: "unparseable" };
  }
  // 2. role-play
  if (isRolePlayAnswer(draft.body)) {
    return REJECTED(REJECTED_ROLE_PLAY);
  }
  // 3. prompt-echo
  if (isPromptEcho(draft.body, input.prompt)) {
    return REJECTED(REJECTED_PROMPT_ECHO);
  }

  const context = await input.resolveContext();
  if (context === null) {
    return { kind: "abandoned" };
  }

  // 4. delivered-hint-echo
  if (isEchoOfDeliveredHint(draft.body, context.deliveredHintHashes)) {
    return REJECTED(REJECTED_HINT_ECHO);
  }
  // 5. secret-scan — booked WITHOUT the match, like every other secret
  //    refusal in this product: the count says a drop happened, the reason
  //    says which class, and neither says what was in it.
  if (containsSecret(draft.body)) {
    return REJECTED(REJECTED_SECRET);
  }

  // 6. wire-contract
  const claim: DerivedClaim = {
    id: mintClaimId(),
    workContextId: context.workContextId,
    authorSessionId: context.authorSessionId,
    kind: draft.kind,
    body: draft.body,
    status: "proposed",
    confidence: draft.confidence,
    captureMode: "auto",
    provenance: "derived",
    evidenceRefs: [],
    createdAt: input.now.toISOString(),
  };
  if (!checkClaim(claim).ok) {
    return REJECTED(REJECTED_CONTRACT);
  }
  return { kind: "claim", claim };
};
