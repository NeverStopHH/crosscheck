/**
 * `publish_claim` — one assertion, on the caller's OWN work context.
 *
 * It never takes a work context id. The caller's own context is the one
 * SessionStart created for this session, and letting a model name a destination
 * here would make `publish_claim` and `extend_diagnosis` the same tool with
 * different validation. Writing into somebody else's tree is a deliberate act
 * with an edge attached, and that is the other tool.
 */
import { z } from "zod";
import { ClaimKindSchema, ClaimStatusSchema } from "@crosscheck/schema";

import { toolFailure, toolText } from "../protocol.ts";
import type { ToolResult } from "../protocol.ts";
import type { McpContext } from "../context.ts";
import { quotingText, safeId } from "../render.ts";
import { resolveOwnWorkContext } from "../session.ts";
import type { OwnWorkContext } from "../session.ts";
import { checkClaim, explainRejection } from "../violations.ts";
import { isEchoOfDeliveredHint } from "../../hints/echo.ts";
import { readSessionState } from "../../state/session-state.ts";
import { postRecords } from "../../http/hub.ts";
import {
  envelopeFor,
  hubFailure,
  issuesOf,
  mintClaimId,
  parseArgs,
  resultAt,
} from "./shared.ts";

/**
 * Neither confident nor dismissive. A model that omits `confidence` is not
 * making a statement about certainty, so the default must not make one for it.
 */
const DEFAULT_CONFIDENCE = 0.6;

const CONFIDENCE_DECIMALS = 2;

export const ArgsSchema = z.object({
  kind: ClaimKindSchema.describe(
    "What kind of assertion this is: observation (what you saw), hypothesis " +
      "(what you think), evidence (what supports or refutes a hypothesis), " +
      "root_cause (why it happens), decision (what was chosen), " +
      "rejected_approach (what was tried and abandoned, and why).",
  ),
  body: z
    .string()
    .min(1)
    .describe("The assertion itself, in one sentence. Max 400 characters."),
  status: ClaimStatusSchema.default("proposed").describe(
    "How settled this is. likely_root_cause requires at least one evidenceRefs entry.",
  ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .default(DEFAULT_CONFIDENCE)
    .describe("0 to 1. Be honest — teammates read this."),
  evidenceRefs: z
    .array(z.string().min(1))
    .default([])
    .describe(
      "Ids of claims that support this one. Get them from get_diagnosis.",
    ),
});

export const definition = {
  name: "publish_claim",
  description:
    "Record one assertion about the problem you are working on — an observation, a " +
    "hypothesis, a piece of evidence, a root cause, a decision, or an approach you " +
    "rejected — onto your own crosscheck work context, so teammates and their agents " +
    "can see your reasoning instead of repeating it. Use it when you conclude " +
    "something, not to narrate. Returns the claim's id, which you can pass to other " +
    "tools as an evidence ref.",
  inputSchema: z.toJSONSchema(ArgsSchema) as Record<string, unknown>,
};

/**
 * The message for a repo where SessionStart has not run.
 *
 * Naming the hook matters: the fix differs depending on whether crosscheck was
 * never installed here (`crosscheck init`) or is installed and this session
 * predates it (restart), and the sentence has to leave room for both.
 */
export const NO_SESSION =
  "crosscheck has no active session for this repo, so there is no work context to " +
  "publish onto. The SessionStart hook is what creates it: run crosscheck doctor to " +
  "see whether the hooks are registered, crosscheck init if they are not, and then " +
  "restart the session so SessionStart runs.";

export const requireOwnContext = (
  ctx: McpContext,
): Promise<OwnWorkContext | null> =>
  resolveOwnWorkContext(ctx.config.home, ctx.identity, ctx.config.hubUrl);

/** A contract violation, as the list of sentences the caller can act on. */
export const contractFailure = (messages: readonly string[]): ToolResult =>
  toolFailure(
    `That claim does not satisfy the crosscheck contract:\n${messages
      .map((message) => `- ${message}`)
      .join("\n")}`,
  );

/**
 * Echo-loop exclusion (DESIGN.md §3, judge-mandated). The body arrived IN
 * THIS SESSION as a teammate hint, so publishing it would mint the teammate's
 * finding as this session's independent observation — the exact laundering
 * §3 forbids. The refusal names the honest alternative: extending THEIR tree.
 *
 * Deterministic and honestly bounded: normalized-equality only (the same v0
 * limit the hub's ingest dedup documents) — a paraphrase is not caught.
 */
export const ECHO_REFUSAL =
  "That text arrived in this session as a crosscheck hint — it is a teammate's " +
  "recorded claim, not this session's independent observation, so publishing it as a " +
  "new claim is refused (echo-loop exclusion). To build on it, read the teammate's " +
  "tree with get_diagnosis and add your claim there with extend_diagnosis, which " +
  "keeps the provenance chain honest.";

/**
 * Whether this session's delivered hints contain the body. Read fresh per
 * call: hooks may have delivered another hint since the MCP server started.
 * Missing state fails OPEN (no refusal) — the marker can only exist where a
 * hint was actually delivered, and a hint delivery guarantees the state file.
 */
const isDeliveredHintEcho = async (
  ctx: McpContext,
  own: OwnWorkContext,
  body: string,
): Promise<boolean> => {
  const state = await readSessionState(ctx.config.home, own.claudeSessionId);
  return (
    state !== null && isEchoOfDeliveredHint(body, state.deliveredHintHashes)
  );
};

export const run = async (
  ctx: McpContext,
  args: unknown,
): Promise<ToolResult> => {
  const parsed = parseArgs(ArgsSchema, args, definition.name);
  if (!parsed.ok) {
    return parsed.result;
  }
  const own = await requireOwnContext(ctx);
  if (own === null) {
    return toolFailure(NO_SESSION);
  }
  if (await isDeliveredHintEcho(ctx, own, parsed.value.body)) {
    return toolFailure(ECHO_REFUSAL);
  }

  const claim = {
    id: mintClaimId(),
    workContextId: own.workContextId,
    authorSessionId: own.crosscheckSessionId,
    kind: parsed.value.kind,
    body: parsed.value.body,
    status: parsed.value.status,
    confidence: parsed.value.confidence,
    captureMode: "agent",
    // An agent calling this tool is DECLARING, not deriving: it asserts the
    // claim on its own account, so the derived-confidence cap (DESIGN.md §3)
    // does not apply — and must not be quietly borrowed to escape it either.
    provenance: "declared",
    evidenceRefs: parsed.value.evidenceRefs,
    createdAt: ctx.now().toISOString(),
  };

  // Checked HERE rather than left to the hub: the rules live in the shared
  // contract, so this connector can state them without a round trip and the
  // agent gets a sentence instead of a rejection count.
  const rules = checkClaim(claim);
  if (!rules.ok) {
    return contractFailure(rules.messages);
  }

  const producer = {
    sessionId: own.crosscheckSessionId,
    developerId: own.developerId,
  };
  const posted = await postRecords(ctx.hub, [
    envelopeFor(ctx, producer, "claim", claim),
  ]);
  if (!posted.ok) {
    return hubFailure(ctx, posted);
  }

  const outcome = resultAt(posted.data.results, 0);
  if (outcome?.status === "rejected") {
    // `explainRejection` frames what the hub said, so the notice naming the
    // frame travels with it.
    return toolFailure(
      quotingText(
        "The hub did not accept that claim.",
        explainRejection(issuesOf(outcome)),
      ),
    );
  }
  if (outcome?.status === "duplicate") {
    // The id is the HUB's — `results[].id` is whatever the response said the
    // existing claim is — so it goes through the same allowlist every other
    // printed id does. Bare rather than framed: an agent has to be able to pass
    // it back as an evidence ref.
    return toolText(
      `That claim was already recorded on your work context as ${safeId(outcome.id ?? claim.id)}. ` +
        "crosscheck deduplicates identical claims from the same author, so nothing was " +
        "added and the existing claim's last-seen time was refreshed instead.",
    );
  }
  return toolText(
    `Recorded ${claim.id} as a ${claim.kind} on your work context ${own.workContextId} ` +
      `(status ${claim.status}, confidence ${claim.confidence.toFixed(CONFIDENCE_DECIMALS)}). ` +
      "Pass this id as an evidenceRefs entry when you publish what supports it.",
  );
};
