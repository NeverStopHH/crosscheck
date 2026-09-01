/**
 * `answer_question` — reply to a question a teammate addressed to you
 * (roadmap R2).
 *
 * AN ANSWER IS A CLAIM, not a message, and that is the whole design. Stack
 * Overflow's oldest rule is that an answer posted as a comment cannot be
 * accepted, cited or found later; here the same thing is true structurally —
 * a claim is attributable, carries trust labels, joins the answerer's own
 * tree, and can be passed as an evidence ref. The `answers` edge is what
 * carries it back to the person who asked.
 *
 * It lands on the ANSWERER'S OWN work context, exactly like `publish_claim`.
 * Writing into the asker's tree would be `extend_diagnosis` — a different,
 * deliberate act with an edge of its own — and an answer is this session's
 * assertion, not an addition to somebody else's diagnosis.
 *
 * WHO MAY ANSWER is decided by the hub, and its refusal is deliberately the
 * same sentence for "that question is not yours" and "no question has that
 * id": telling the two apart would let a caller enumerate the hub's questions
 * by probing ids, and a question body is another developer's text.
 */
import { z } from "zod";
import { ClaimKindSchema } from "@crosscheck/schema";
import { CLAIM_ECHO_MAX_CHARS } from "../../constants.ts";

import { toolFailure, toolText } from "../protocol.ts";
import type { ToolResult } from "../protocol.ts";
import type { McpContext } from "../context.ts";
import { quotedBody, quotingText, safeId } from "../render.ts";
import { checkClaim } from "../violations.ts";
import { redactionNote } from "../../briefing/sanitize.ts";
import { containsSecret } from "../../capture/secret-scan.ts";
import { isEchoOfDeliveredHint } from "../../hints/echo.ts";
import { answerQuestion } from "../../http/hub.ts";
import { readSessionState } from "../../state/session-state.ts";
import {
  contractFailure,
  NO_SESSION,
  requireOwnContext,
} from "./publish-claim.ts";
import { hubFailure, idArg, mintClaimId, parseArgs } from "./shared.ts";

/** An answer is a statement, not a hedge — the publish_claim default. */
const DEFAULT_CONFIDENCE = 0.6;

export const ArgsSchema = z.object({
  questionId: idArg(
    "question",
    "The question you are answering, from your briefing's Questions for you " +
      "block or from list_open_questions.",
  ),
  body: z
    .string()
    .min(1)
    .describe(
      "The answer itself, in one or two sentences — what you found, decided or " +
        "ruled out. Max 400 characters. It is recorded as a claim on your own " +
        "work context, under your name, and reaches the person who asked.",
    ),
  kind: ClaimKindSchema.default("observation").describe(
    "What kind of assertion the answer is: observation (what you saw), " +
      "rejected_approach (what you tried and abandoned, and why), root_cause, " +
      "decision, hypothesis, evidence. Most answers are observations or " +
      "rejected approaches.",
  ),
});

export const definition = {
  name: "answer_question",
  description:
    "Answer a question a teammate asked you through crosscheck. The answer is " +
    "recorded as a claim on your own work context and delivered to the person who " +
    "asked at their next prompt — they are not waiting on a chat window. Only the " +
    "teammate a question names, or the owner of the work context it is about, can " +
    "answer it. Answering again with a correction is allowed and both are kept.",
  inputSchema: z.toJSONSchema(ArgsSchema) as Record<string, unknown>,
};

/**
 * The echo-loop exclusion, the `publish_claim` rule applied here for exactly
 * the same reason: a sentence that arrived IN THIS SESSION as a teammate's
 * hint is their finding, and answering with it would launder their claim into
 * this developer's answer under this developer's name.
 */
export const ANSWER_ECHO_REFUSAL =
  "That text arrived in this session as a crosscheck hint — it is a teammate's " +
  "recorded claim, not your own answer, so sending it as one is refused " +
  "(echo-loop exclusion). Answer in your own words, or point at the teammate's " +
  "finding by naming it.";

/**
 * The secret gate, and an answer needs it MORE than a question does. A
 * question lands in a teammate's briefing as quoted body-class text; an
 * answer lands in the asker's next PROMPT as substance, with no relevance
 * gate in front of it (DESIGN.md §4, the solicited exception) — so a
 * credential in an answer body reaches a second developer's machine and a
 * second model's context. Same rule as everywhere else: drop, never redact,
 * and never echo the match back (DESIGN.md §3).
 */
export const ANSWER_SECRET_REFUSAL =
  "That answer matches a secret pattern (key, token or credential), so it is " +
  "refused rather than uploaded — crosscheck never redacts, it drops. Answer " +
  "without the credential material in it.";

export const run = async (
  ctx: McpContext,
  args: unknown,
): Promise<ToolResult> => {
  const parsed = parseArgs(ArgsSchema, args, definition.name);
  if (!parsed.ok) {
    return parsed.result;
  }
  // Before the session lookup and before any round trip, exactly where
  // `ask_teammate` scans: nothing credential-shaped is worth either, and the
  // refusal must not quote it back.
  if (containsSecret(parsed.value.body)) {
    return toolFailure(ANSWER_SECRET_REFUSAL);
  }
  const own = await requireOwnContext(ctx);
  if (own === null) {
    return toolFailure(NO_SESSION);
  }
  const state = await readSessionState(ctx.config.home, own.hostSessionKey);
  if (
    state !== null &&
    isEchoOfDeliveredHint(parsed.value.body, state.deliveredHintHashes)
  ) {
    return toolFailure(ANSWER_ECHO_REFUSAL);
  }

  const claim = {
    id: mintClaimId(),
    workContextId: own.workContextId,
    authorSessionId: own.crosscheckSessionId,
    kind: parsed.value.kind,
    body: parsed.value.body,
    status: "proposed",
    confidence: DEFAULT_CONFIDENCE,
    captureMode: "agent",
    // An agent answering is DECLARING on its own account, like publish_claim:
    // the derived cap is about machine inference nobody confirmed.
    provenance: "declared",
    evidenceRefs: [],
    createdAt: ctx.now().toISOString(),
  };
  // The shared contract, checked locally: the caller gets a sentence about
  // the rule it broke rather than a rejection count from a round trip.
  const rules = checkClaim(claim);
  if (!rules.ok) {
    return contractFailure(rules.messages);
  }

  const posted = await answerQuestion(ctx.hub, parsed.value.questionId, claim);
  if (!posted.ok) {
    return hubFailure(ctx, posted);
  }
  // Audit row M14, the author's half: the phrase filter runs at RENDER time on
  // the READER's machine, so without this the author never learns that the
  // sentence they just sent arrives with a hole in it. A note beside a stored
  // record, never a refusal — the text is legal and only its rendering changes.
  const note = redactionNote(parsed.value.body);
  const notes = note === null ? [] : [note];
  // BODY class, for the reason spelled out in ask-teammate.ts: the echo must
  // show the author the shape the note beside it promises, which is also the
  // shape the asker receives (hints/render.ts renderAnswerHint).
  const framed = quotedBody(parsed.value.body, CLAIM_ECHO_MAX_CHARS);
  if (posted.data.duplicate) {
    return toolText(
      quotingText(
        `That answer is already recorded against ${safeId(parsed.value.questionId)}: ${framed}.`,
        "Nothing was sent a second time.",
        ...notes,
      ),
    );
  }
  return toolText(
    quotingText(
      `Answered ${safeId(parsed.value.questionId)} with claim ${safeId(posted.data.claimId ?? claim.id)}: ${framed}.`,
      "It is recorded on your own work context under your name, and reaches the " +
        "teammate who asked at one of their next prompts. If you learn something " +
        "that changes it, answer again — both answers are kept and the newer one " +
        "arrives beside the first.",
      ...notes,
    ),
  );
};
