/**
 * `ask_teammate` — one question, to one teammate, that waits (roadmap R2).
 *
 * The gap it closes: today my agent can read what Ken's agent WROTE DOWN.
 * There is no way to ask him something he has not written down yet, and a
 * live channel would be theatre — his agent is not running when I ask. So
 * this files a question that reaches him at his next SessionStart, and his
 * answer reaches me at my next prompt. Neither of us waits for the other.
 *
 * THREE GATES BEFORE THE HUB SEES ANYTHING, in this order:
 *   1. an addressee — a teammate, a work context, or both. Never a broadcast;
 *   2. the secret scan (QUESTION_SECRET_REFUSAL) — a question is PUSHED into
 *      a teammate's briefing unasked, exactly like a session intent, so it is
 *      scanned like one: drop, never redact, and the refusal never quotes the
 *      matched text back;
 *   3. the length cap, which zod applies from the shared constant.
 *
 * The budget, the dedup and the target resolution are HUB-side on purpose: a
 * modified connector must not be able to lift a spam budget, and only the hub
 * can turn "Ken" into a person or say that three developers answer to it.
 */
import { z } from "zod";
import { MAX_QUESTION_BODY_LENGTH } from "@crosscheck/schema";

import { toolFailure, toolText } from "../protocol.ts";
import type { ToolResult } from "../protocol.ts";
import type { McpContext } from "../context.ts";
import { quoted, quotingText, safeId } from "../render.ts";
import { bareUntrusted, redactionNote } from "../../briefing/sanitize.ts";
import { containsSecret } from "../../capture/secret-scan.ts";
import { askQuestion } from "../../http/hub.ts";
import { NO_SESSION, requireOwnContext } from "./publish-claim.ts";
import { hubFailure, idArg, parseArgs } from "./shared.ts";

export const ArgsSchema = z.object({
  question: z
    .string()
    .min(1)
    .max(MAX_QUESTION_BODY_LENGTH)
    .describe(
      "The question itself, in one or two sentences — what you need to know " +
        "before you start, not a status request. Max 400 characters. It appears " +
        "in their briefing the next time they start a session.",
    ),
  developer: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Who to ask: their full name or any email address the hub knows them by. " +
        "Omit it when you give a workContextId and crosscheck asks whoever owns it. " +
        "A name that matches nobody, or several people, comes back as an error " +
        "naming the closest spellings or the exact addresses.",
    ),
  workContextId: idArg(
    "work context",
    "The work context the question is about, from search_related_work or " +
      "get_diagnosis. It gives the question its subject and, on its own, decides " +
      "who is asked — whoever owns that context.",
  ).optional(),
});

export const definition = {
  name: "ask_teammate",
  description:
    "Ask one teammate one question about work they have done, and get on with " +
    "something else. The question waits on the crosscheck hub, appears in that " +
    "teammate's briefing the next time they start a session, and their answer " +
    "reaches you as a hint at your next prompt — nobody has to be online at the " +
    "same time. Use it when you are about to redo, undo or work against something " +
    "a teammate may already have settled and their recorded work does not say. " +
    "Questions expire after 14 days, and there is a limit on how many you may " +
    "have open at once.",
  inputSchema: z.toJSONSchema(ArgsSchema) as Record<string, unknown>,
};

/**
 * The secret gate, and the reason it is here rather than only at capture. A
 * question is one of the two pieces of agent-written text crosscheck PUSHES
 * into another developer's context unasked — the session intent is the other
 * — while a claim body stays a pointer until somebody pulls it (DESIGN.md
 * §4). Drop, never redact (§3), and never echo the match.
 */
export const QUESTION_SECRET_REFUSAL =
  "That question matches a secret pattern (key, token or credential), so it is " +
  "refused rather than uploaded — crosscheck never redacts, it drops. Ask the " +
  "question without the credential material in it.";

/**
 * Naming BOTH ways out, because either alone is the wrong advice half the
 * time: sometimes you know who did the work, sometimes you only know the
 * context id search_related_work printed.
 */
export const NO_ADDRESSEE_REFUSAL =
  "ask_teammate needs somebody to ask. Give developer (a teammate's name or " +
  "email address) or workContextId (whoever owns that context is asked), or both. " +
  "crosscheck has no broadcast: a question nobody is answerable for is never sent.";

export const run = async (
  ctx: McpContext,
  args: unknown,
): Promise<ToolResult> => {
  const parsed = parseArgs(ArgsSchema, args, definition.name);
  if (!parsed.ok) {
    return parsed.result;
  }
  const { question, developer, workContextId } = parsed.value;
  if (developer === undefined && workContextId === undefined) {
    return toolFailure(NO_ADDRESSEE_REFUSAL);
  }
  // Before the session lookup and before any round trip: nothing
  // credential-shaped is worth either, and the refusal must not quote it back.
  if (containsSecret(question)) {
    return toolFailure(QUESTION_SECRET_REFUSAL);
  }
  const own = await requireOwnContext(ctx);
  if (own === null) {
    return toolFailure(NO_SESSION);
  }

  const posted = await askQuestion(ctx.hub, {
    // Minted here so a retry of the same call is idempotent on the hub.
    id: `qn_${crypto.randomUUID()}`,
    repo: ctx.identity.repoId,
    sessionId: own.crosscheckSessionId,
    body: question,
    ...(developer === undefined ? {} : { developer }),
    ...(workContextId === undefined ? {} : { workContextId }),
  });
  if (!posted.ok) {
    return hubFailure(ctx, posted);
  }
  // Audit row M14, the author's half: the phrase filter runs at RENDER time on
  // the READER's machine, so without this the author never learns that the
  // sentence they just sent arrives with a hole in it. A note beside a stored
  // record, never a refusal — the text is legal and only its rendering changes.
  const note = redactionNote(question);
  const notes = note === null ? [] : [note];
  const framed = quoted(question, MAX_QUESTION_BODY_LENGTH);
  if (posted.data.duplicate) {
    // The house rule, applied to this channel: a record that carries nothing
    // new is a duplicate, not a rejection — and the sentence names the id the
    // caller already has open, so it can be followed rather than re-sent.
    return toolText(
      quotingText(
        `You already have that question open as ${safeId(posted.data.questionId ?? "")}: ${framed}.`,
        "Nothing was sent a second time. It is still waiting for an answer, and it " +
          "expires 14 days after you first asked it.",
        ...notes,
      ),
    );
  }
  // WHO, when the hub says so. It matters most on the workContextId-only path,
  // where the caller asked "whoever owns it" and cannot otherwise learn who
  // that was — and an agent reporting "I asked the owner" leaves its developer
  // unable to tell Ken-on-holiday from Mike-at-his-desk. BARE untrusted like
  // every other teammate name; a name that does not survive the sanitizer, or
  // an older hub that does not send one, falls back to the pronoun.
  const target = bareUntrusted(posted.data.targetDeveloperName ?? "");
  const asked = target.length === 0 ? "Asked" : `Asked ${target}`;
  const theirs = target.length === 0 ? "their" : `${target}'s`;
  return toolText(
    quotingText(
      `${asked} as ${safeId(posted.data.question?.id ?? posted.data.questionId ?? "")}: ${framed}.`,
      `It appears in ${theirs} briefing the next time they start a crosscheck session, and ` +
        "their answer reaches you as a hint at one of your next prompts. Nothing " +
        "happens if they do not answer: the question expires after 14 days and " +
        "crosscheck status tells you it did. Do not wait for it — carry on.",
      ...notes,
    ),
  );
};
