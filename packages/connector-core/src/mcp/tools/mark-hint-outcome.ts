/**
 * `mark_hint_outcome` — what a crosscheck hint led to, said by the agent that
 * read it (1.0 spec 07 §13).
 *
 * THE AGENT IS THE WITNESS. It read the pointer and it either reused the
 * teammate's decision, or set it aside for a reason, or found it beside the
 * point for this task — nobody else saw which. So this is the one pilot
 * record an agent writes, and it is written to `hint_outcomes`, never to
 * `pilot_marks`: whether the intervention was WORTH it stays the person's
 * label, and an agent writing that would be the product grading itself
 * (07 D3, PIL-6). `noise` is therefore refused here by name, with the
 * person's own command in the sentence — not silently coerced into a word
 * the agent did not say.
 *
 * WHICH DELIVERY. The hint printed a work-context or claim id, never a
 * delivery id; the tool sends that ref and, when this checkout's session is
 * unambiguous, the session that read it, and the hub resolves the delivery.
 * An ambiguous session sends none and the hub takes the newest — the same
 * rule `get_diagnosis` follows for the pulls it stamps.
 *
 * NOTHING WRITTEN BY ANYONE ELSE IS ECHOED. The answer carries the caller's
 * own ref through `safeId` and fixed words; a hub refusal goes through
 * `hubFailure`, whose message is framed like every hub-sent string.
 */
import { z } from "zod";
import { HINT_OUTCOMES, MAX_HINT_OUTCOME_REASON_CHARS } from "@crosscheck/schema";

import { containsSecret } from "../../capture/secret-scan.ts";
import { isOutcomesNotServed, postHintOutcome } from "../../http/hint-outcomes.ts";
import type { RecordedOutcome } from "../../http/hint-outcomes.ts";
import { toolFailure, toolText } from "../protocol.ts";
import type { ToolResult } from "../protocol.ts";
import type { McpContext } from "../context.ts";
import { safeId } from "../render.ts";
import { resolveOwnWorkContext } from "../session.ts";
import { hubFailure, idArg, parseArgs } from "./shared.ts";

/** The word an agent may NOT record — the person's label (crosscheck noise). */
const NOISE_WORD = "noise";

export const ArgsSchema = z.object({
  ref: idArg(
    "hint",
    "The id the hint printed: the work context (wc_…) or claim (clm_…) it pointed at.",
  ),
  outcome: z
    .enum(HINT_OUTCOMES)
    .describe(
      "followed: you acted on it. overrode: you saw it and deliberately went another way. " +
        "not_relevant_now: on topic, not needed for this task.",
    ),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(MAX_HINT_OUTCOME_REASON_CHARS)
    .optional()
    .describe("One sentence. Required for overrode: why your way was better."),
});

export const definition = {
  name: "mark_hint_outcome",
  description:
    "Record what a crosscheck hint, pointer or tripwire ask led to, once, when you act on it " +
    "or deliberately deviate from it: followed (you reused the teammate's decision, stopped " +
    "duplicate work or coordinated), overrode (you saw it and deliberately went another way — " +
    "give the reason, one sentence on why your way was better), or not_relevant_now. A later " +
    "call supersedes an earlier one; nothing is deleted. An off-target hint is not recorded " +
    "here: noise is the person's own label (crosscheck noise). The outcome is attributed to " +
    "your developer's key and shown in full only to them (crosscheck pilot --mine); others see " +
    "it only inside the team report's totals for a whole past month, shown once at least three " +
    "people recorded outcomes about at least three people's work; the teammate whose work it " +
    "was sees how often their work was followed.",
  inputSchema: z.toJSONSchema(ArgsSchema) as Record<string, unknown>,
};

export const NOISE_IS_THE_PERSONS_LABEL =
  "noise is not an outcome you record: whether a hint was off-target is the person's own " +
  "label, made in a terminal with crosscheck noise. If the hint was on topic but not needed " +
  "for this task, record not_relevant_now; if you went another way on purpose, overrode.";

export const OVERRIDE_NEEDS_REASON =
  "mark_hint_outcome was called with overrode and no reason. An override is recorded with " +
  "one sentence on why your way was better — without it, it cannot be told from noise.";

export const REASON_SECRET_REFUSAL =
  "That reason matches a secret pattern (key, token or credential), so nothing was sent — " +
  "crosscheck never redacts, it drops. Say it again without the credential material.";

export const OUTCOMES_NOT_SERVED =
  "This hub does not record hint outcomes — it predates them, so nothing was recorded. " +
  "Whoever runs it can upgrade it; the hint itself is unaffected.";

const recordedText = (ref: string, recorded: RecordedOutcome): string => {
  const shown = safeId(ref);
  const word = safeId(recorded.outcome);
  if (recorded.repeated) {
    return `Already recorded: the hint at ${shown} stands at ${word}. Nothing was written a second time.`;
  }
  const replaced =
    recorded.replaced === null
      ? ""
      : ` It supersedes the earlier ${safeId(recorded.replaced)}, which stays in the history.`;
  return (
    `Recorded: the hint at ${shown} (delivery ${safeId(recorded.deliveryId)}) was ${word}.${replaced} ` +
    "It counts in your own crosscheck pilot --mine."
  );
};

const isNoise = (args: unknown): boolean =>
  typeof args === "object" && args !== null && (args as { outcome?: unknown }).outcome === NOISE_WORD;

export const run = async (ctx: McpContext, args: unknown): Promise<ToolResult> => {
  if (isNoise(args)) {
    return toolFailure(NOISE_IS_THE_PERSONS_LABEL);
  }
  const parsed = parseArgs(ArgsSchema, args, definition.name);
  if (!parsed.ok) {
    return parsed.result;
  }
  const { ref, outcome, reason } = parsed.value;
  if (outcome === "overrode" && reason === undefined) {
    return toolFailure(OVERRIDE_NEEDS_REASON);
  }
  if (reason !== undefined && containsSecret(reason)) {
    return toolFailure(REASON_SECRET_REFUSAL);
  }
  const own = await resolveOwnWorkContext(ctx.config.home, ctx.identity, ctx.config.hubUrl);
  const session = own === null || own.sessionAmbiguous ? undefined : own.crosscheckSessionId;
  const posted = await postHintOutcome(ctx.hub, {
    repo: ctx.identity.repoId,
    ref,
    outcome,
    ...(reason === undefined ? {} : { reason }),
    ...(session === undefined ? {} : { session }),
  });
  if (isOutcomesNotServed(posted)) {
    return toolFailure(OUTCOMES_NOT_SERVED);
  }
  return posted.ok ? toolText(recordedText(ref, posted.data)) : hubFailure(ctx, posted);
};
