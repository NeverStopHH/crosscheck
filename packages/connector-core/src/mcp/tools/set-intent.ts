/**
 * `set_intent` — what this session is trying to accomplish, in one sentence,
 * declared by the agent on its OWN work context (trial finding #16: teammates
 * could not tell WHAT a session was doing — 80 of 80 trial work contexts had
 * no intent). The declared sentence is the only way an intent reaches
 * confidence 1: the connector's automatic derivation is capped and labelled
 * "(derived)", and the hub's merge rule lets a declared intent replace a
 * derived one but never the reverse. Re-declaring supersedes. Same-author by
 * construction — the tool never takes a work context id, exactly like
 * `publish_claim`; the hub's ownership check is the second lock.
 *
 * The summary travels on a work_context UPDATE record (title + status from
 * the session state, intent declared) — no new record kind, no new endpoint.
 */
import { z } from "zod";
import { MAX_INTENT_SUMMARY_CHARS, SessionStatusSchema } from "@crosscheck/schema";

import { toolFailure, toolText } from "../protocol.ts";
import type { ToolResult } from "../protocol.ts";
import type { McpContext } from "../context.ts";
import { quoted, quotingText, safeId } from "../render.ts";
import type { OwnWorkContext } from "../session.ts";
import { checkIntent, explainRejection } from "../violations.ts";
import { isEchoOfDeliveredHint } from "../../hints/echo.ts";
import { postRecords } from "../../http/hub.ts";
import {
  readSessionState,
  updateSessionState,
} from "../../state/session-state.ts";
import { NO_SESSION, contractFailure, requireOwnContext } from "./publish-claim.ts";
import { envelopeFor, hubFailure, issuesOf, parseArgs, resultAt } from "./shared.ts";

/** A declared intent is the session's own statement — full confidence, by definition. */
const DECLARED_CONFIDENCE = 1;
const DECLARED_PROVENANCE = "declared";

export const ArgsSchema = z.object({
  summary: z
    .string()
    .min(1)
    .max(MAX_INTENT_SUMMARY_CHARS)
    .describe(
      "One sentence, third person, stating what this session is trying to accomplish " +
        "— the goal, not the steps. Max 200 characters. Teammates' agents read it.",
    ),
  status: SessionStatusSchema.optional().describe(
    "Optionally move the work context's status at the same time " +
      "(analyzing, planning, implementing, testing, blocked, done).",
  ),
});

export const definition = {
  name: "set_intent",
  description:
    "State in one sentence what this session is trying to accomplish. It lands on your " +
    "own crosscheck work context as a DECLARED intent (confidence 1) and replaces any " +
    "intent crosscheck derived automatically from your first prompt; teammates' " +
    "briefings, prompt hints and the file-overlap tripwire show it, labelled as yours. " +
    "Call it when the goal becomes clear or changes; calling it again supersedes.",
  inputSchema: z.toJSONSchema(ArgsSchema) as Record<string, unknown>,
};

/**
 * A session registered before intent support: its state file carries no
 * title, and the update record needs one. Naming the remedy, like NO_SESSION.
 */
export const NO_TITLE =
  "crosscheck registered this session before it learned to record intents, so " +
  "it has no work-context title to carry the intent on. Restart the session so " +
  "SessionStart re-registers it, then call set_intent again.";

/**
 * Echo-loop exclusion, the publish_claim rule applied to intents: a sentence
 * that arrived IN THIS SESSION as a teammate's hint is their finding, not
 * this session's goal, and declaring it would launder provenance.
 */
export const INTENT_ECHO_REFUSAL =
  "That text arrived in this session as a crosscheck hint — it is a teammate's " +
  "recorded claim, not a statement of this session's own goal, so declaring it as " +
  "your intent is refused (echo-loop exclusion). State the goal in your own words.";

const isDeliveredHintEcho = async (
  ctx: McpContext,
  own: OwnWorkContext,
  summary: string,
): Promise<boolean> => {
  const state = await readSessionState(ctx.config.home, own.hostSessionKey);
  return state !== null && isEchoOfDeliveredHint(summary, state.deliveredHintHashes);
};

export const run = async (ctx: McpContext, args: unknown): Promise<ToolResult> => {
  const parsed = parseArgs(ArgsSchema, args, definition.name);
  if (!parsed.ok) {
    return parsed.result;
  }
  const own = await requireOwnContext(ctx);
  if (own === null) {
    return toolFailure(NO_SESSION);
  }
  if (own.workContextTitle === null || own.workContextStatus === null) {
    return toolFailure(NO_TITLE);
  }
  if (await isDeliveredHintEcho(ctx, own, parsed.value.summary)) {
    return toolFailure(INTENT_ECHO_REFUSAL);
  }

  const intent = {
    summary: parsed.value.summary,
    provenance: DECLARED_PROVENANCE,
    confidence: DECLARED_CONFIDENCE,
    capturedAt: ctx.now().toISOString(),
  };
  // The shared contract, stated locally: the agent gets a sentence, not a
  // rejection count, and the hub never sees a record it must refuse.
  const rules = checkIntent(intent);
  if (!rules.ok) {
    return contractFailure(rules.messages);
  }
  const status = parsed.value.status ?? own.workContextStatus;
  const body = {
    id: own.workContextId,
    sessionId: own.crosscheckSessionId,
    title: own.workContextTitle,
    status,
    intent,
    createdAt: own.startedAt,
  };
  const producer = { sessionId: own.crosscheckSessionId, developerId: own.developerId };
  const posted = await postRecords(ctx.hub, [
    envelopeFor(ctx, producer, "work_context", body),
  ]);
  if (!posted.ok) {
    return hubFailure(ctx, posted);
  }
  const outcome = resultAt(posted.data.results, 0);
  if (outcome?.status === "rejected") {
    return toolFailure(
      quotingText("The hub did not accept that intent.", explainRejection(issuesOf(outcome))),
    );
  }
  if (parsed.value.status !== undefined) {
    // Keep the state's status in step so a later intent writer re-sends
    // what the hub now holds (best-effort, like every state update).
    await updateSessionState(ctx.config.home, own.hostSessionKey, (fresh) => ({
      ...fresh,
      workContextStatus: status,
    }));
  }
  const framed = quoted(parsed.value.summary, MAX_INTENT_SUMMARY_CHARS);
  if (outcome?.status === "duplicate") {
    return toolText(
      quotingText(
        `That intent is already recorded on your work context ${safeId(own.workContextId)}: ${framed}. Nothing changed.`,
      ),
    );
  }
  return toolText(
    quotingText(
      `Recorded your intent on work context ${safeId(own.workContextId)}: ${framed}.`,
      "It is declared (confidence 1) and replaces any intent crosscheck derived from your " +
        "first prompt; teammates' briefings, prompt hints and the file-overlap tripwire " +
        "now show it. Calling set_intent again supersedes it.",
    ),
  );
};
