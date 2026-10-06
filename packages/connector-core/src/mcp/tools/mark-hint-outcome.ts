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
 * A DELIVERY STILL ON THIS MACHINE (review #14, round 3). A prompt hint's
 * delivery is spooled and sent after the next tool runs. The tool posts
 * FIRST; only when the hub does not know a ref the spool holds does the one
 * live session of this checkout send its own held records, bounded, before
 * the post is made once more — never a guessed or silent session. It never
 * repeats the hub's "no hint with that id reached you" for a ref the spool
 * still holds; it says why that delivery is still here.
 *
 * NOTHING WRITTEN BY ANYONE ELSE IS ECHOED. The answer carries the caller's
 * own ref through `safeId` and fixed words; a hub refusal goes through
 * `hubFailure`, whose message is framed like every hub-sent string.
 */
import { z } from "zod";
import { HINT_OUTCOMES, MAX_HINT_OUTCOME_REASON_CHARS } from "@crosscheck/schema";

import { containsSecret } from "../../capture/secret-scan.ts";
import { OUTCOME_FLUSH_BUDGET_MS } from "../../constants.ts";
import type { HubResult } from "../../http/client.ts";
import { isOutcomesNotServed, postHintOutcome } from "../../http/hint-outcomes.ts";
import type { RecordedOutcome } from "../../http/hint-outcomes.ts";
import { toolFailure, toolText } from "../protocol.ts";
import type { ToolResult } from "../protocol.ts";
import type { McpContext } from "../context.ts";
import { safeId } from "../render.ts";
import { resolveOwnWorkContext } from "../session.ts";
import { answerAfterSendingHeld, heldDeliveryIdOf } from "../../spool/held-deliveries.ts";
import type { HeldWhy } from "../../spool/held-deliveries.ts";
import { hubFailure, idArg, parseArgs } from "./shared.ts";

/** The word an agent may NOT record — the person's label (crosscheck noise). */
const NOISE_WORD = "noise";
/** The hub's refusal for a ref it has no delivery of, for this caller. */
const UNKNOWN_REF = "unknown_ref";

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
    "call supersedes an earlier one, but never the person's own word (their crosscheck noise, " +
    "followed or overrode), which stands; nothing is deleted. An off-target hint is not recorded " +
    "here: noise is the person's own label (crosscheck noise). The outcome is attributed to " +
    "your developer's key and shown in full only to them (crosscheck pilot --mine); others see " +
    "it only inside totals for a whole past month — the team report's, and the source " +
    "teammate's count of how often their work was followed — each shown only if, leaving out " +
    "any one person's words, words from at least three people remain, so a team of three " +
    "never gets either.",
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

export const DELIVERY_STILL_ON_THIS_MACHINE =
  "That hint reached you, but its delivery is still on this machine: crosscheck sends it to the hub " +
  "after your next tool call, and it could not be sent just now — nothing was recorded. Call " +
  "mark_hint_outcome again after your next tool call.";

export const DELIVERY_HELD_AMBIGUOUS =
  "That hint reached you, but its delivery is still on this machine, and several crosscheck sessions are " +
  "live in this checkout, so it was not sent in a guessed one's name — nothing was recorded. The session " +
  "holding it sends it after its next tool call; call mark_hint_outcome again then.";

export const DELIVERY_HELD_NO_LIVE_SESSION =
  "That hint reached you, but its delivery is still on this machine and no crosscheck session is live here " +
  "to send it — nothing was recorded. It is sent when a session on this repo next starts; call " +
  "mark_hint_outcome again then.";

/** What is true of a held delivery, by why it is still held (07 §13.11). */
const HELD_SENTENCE: Readonly<Record<HeldWhy, string>> = {
  unsent: DELIVERY_STILL_ON_THIS_MACHINE,
  ambiguous: DELIVERY_HELD_AMBIGUOUS,
  no_live_session: DELIVERY_HELD_NO_LIVE_SESSION,
};

export const OUTCOMES_NOT_SERVED =
  "This hub does not record hint outcomes — it predates them, so nothing was recorded. " +
  "Whoever runs it can upgrade it; the hint itself is unaffected.";

/** Why the agent's word is not what stands: the person said something, and it is theirs (07 §13.12). */
const NEVER_OVERTURNS = "an agent's word never overturns the person's own";

/** The person's word that stands over the agent's — their noise label, or their own outcome. */
const personsWord = (stands: string): string =>
  stands === NOISE_WORD ? "the person's noise label" : `the person's own ${safeId(stands)}`;

const capitalised = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/**
 * What the new word did to what stood before (review #11). The agent's word
 * is recorded, but whenever the person said something it stands over it (07
 * §13.12), and the answer says so rather than claiming the word took.
 */
const supersededText = (recorded: RecordedOutcome): string => {
  const stands = recorded.stands ?? recorded.outcome;
  if (stands !== recorded.outcome) {
    return ` ${capitalised(personsWord(stands))} still stands: ${NEVER_OVERTURNS}.`;
  }
  if (recorded.reasonRevised === true) {
    return " The reason is revised; the earlier one stays in the history.";
  }
  if (recorded.replaced === null) {
    return "";
  }
  const earlier =
    recorded.replaced === NOISE_WORD ? "your earlier noise label" : `the earlier ${safeId(recorded.replaced)}`;
  return ` It supersedes ${earlier}, which stays in the history.`;
};

/**
 * A REPEAT SAYS WHAT STANDS (07 §13.11, H2, §13.12): the word said again may
 * sit under something the person said, before it or since, and then the
 * person's word still stands.
 */
const repeatedText = (shown: string, recorded: RecordedOutcome): string => {
  const stands = recorded.stands ?? recorded.outcome;
  if (stands === recorded.outcome) {
    return `Already recorded: the hint at ${shown} stands at ${safeId(stands)}. Nothing was written a second time.`;
  }
  return (
    `Already recorded: the hint at ${shown} was ${safeId(recorded.outcome)} before, and ${personsWord(stands)} ` +
    `stands over it: ${NEVER_OVERTURNS}. Nothing was written a second time.`
  );
};

const recordedText = (ref: string, recorded: RecordedOutcome): string => {
  const shown = safeId(ref);
  if (recorded.repeated) {
    return repeatedText(shown, recorded);
  }
  return (
    `Recorded: the hint at ${shown} (delivery ${safeId(recorded.deliveryId)}) was ${safeId(recorded.outcome)}.` +
    `${supersededText(recorded)} It counts in your own crosscheck pilot --mine.`
  );
};

const isUnknownRef = (result: HubResult<RecordedOutcome>): boolean => !result.ok && result.code === UNKNOWN_REF;

const answerText = (ctx: McpContext, ref: string, posted: HubResult<RecordedOutcome>): ToolResult => {
  if (isOutcomesNotServed(posted)) {
    return toolFailure(OUTCOMES_NOT_SERVED);
  }
  return posted.ok ? toolText(recordedText(ref, posted.data)) : hubFailure(ctx, posted);
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
  // HELD FIRST (07 §13.12, review H-A): today's delivery still held here is named by its own id,
  // so the word never lands on an older delivery of the same ref the hub already has.
  const posted = (await heldDeliveryIdOf(ctx.hub, ctx.identity, ref)) ?? ref;
  // The AGENT's route (07 §13.12): what an agent says never overturns the person's own word.
  const call = (): Promise<HubResult<RecordedOutcome>> =>
    postHintOutcome(
      ctx.hub,
      {
        repo: ctx.identity.repoId,
        ref: posted,
        outcome,
        ...(reason === undefined ? {} : { reason }),
        ...(session === undefined ? {} : { session }),
      },
      "agent",
    );
  // POST FIRST (07 §13.11): held records are sent only when the hub does not know a ref held here.
  const answer = await answerAfterSendingHeld(
    {
      hub: ctx.hub,
      identity: ctx.identity,
      ref: posted,
      budgetMs: OUTCOME_FLUSH_BUDGET_MS,
      call,
      isUnknown: isUnknownRef,
    },
    await call(),
  );
  return answer.kind === "held" ? toolFailure(HELD_SENTENCE[answer.why]) : answerText(ctx, ref, answer.result);
};
