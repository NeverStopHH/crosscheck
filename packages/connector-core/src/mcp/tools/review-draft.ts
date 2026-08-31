/**
 * `review_draft` — the promotion loop's write half (DESIGN.md §3 Tier 1):
 * confirm, edit or discard ONE of the caller's own unreviewed Tier-1 drafts.
 *
 * A DEDICATED tool rather than a mode on `publish_claim`, deliberately:
 * publish_claim's contract is "one NEW assertion on your own context, no ids
 * taken" (its header spells out why), while review is an adjudication of an
 * EXISTING row — it takes a claim id, and its three verbs share none of
 * publish's semantics. Folding them together would recreate exactly the
 * publish/extend split that was already refused once.
 *
 * APPEND-ONLY MECHANICS, always: every action mints a NEW claim plus a
 * supersedes edge pointing at the draft. The draft row is never mutated —
 * "reviewed" is a graph fact the hub's notSuperseded filters read.
 *   confirm — same body, provenance DECLARED (the agent now vouches);
 *   edit    — corrected body, provenance DECLARED;
 *   discard — same body, status REJECTED, provenance stays DERIVED, because
 *             nobody vouched for the content — the agent only judged it
 *             not worth keeping, and a discard must not look like knowledge.
 */
import { z } from "zod";
import { DERIVED_CONFIDENCE_CAP } from "@crosscheck/schema";
import { CLAIM_ECHO_MAX_CHARS } from "../../constants.ts";

import { toolFailure, toolText } from "../protocol.ts";
import type { ToolResult } from "../protocol.ts";
import type { McpContext } from "../context.ts";
import { quotedBody, quotingText, safeId } from "../render.ts";
import { checkClaim, explainRejection } from "../violations.ts";
import { containsSecret } from "../../capture/secret-scan.ts";
import { isEchoOfDeliveredHint } from "../../hints/echo.ts";
import { getDrafts, postRecords } from "../../http/hub.ts";
import type { DraftEntry } from "../../http/hub.ts";
import { readSessionState } from "../../state/session-state.ts";
import type { OwnWorkContext } from "../session.ts";
import {
  contractFailure,
  NO_SESSION,
  requireOwnContext,
} from "./publish-claim.ts";
import {
  envelopeFor,
  hubFailure,
  idArg,
  issuesOf,
  mintClaimId,
  mintEdgeId,
  parseArgs,
  resultAt,
} from "./shared.ts";

const ACTIONS = ["confirm", "edit", "discard"] as const;

export const ArgsSchema = z.object({
  draft_claim_id: idArg(
    "draft claim",
    "The id of one of YOUR unreviewed draft claims — the SessionStart " +
      "briefing lists them.",
  ),
  action: z
    .enum(ACTIONS)
    .describe(
      "confirm (the draft is right — publish it as your own declared claim), " +
        "edit (right idea, wrong words — publish a corrected body), or " +
        "discard (not worth keeping — mark it rejected).",
    ),
  body: z
    .string()
    .min(1)
    .optional()
    .describe("edit only: the corrected assertion. Max 400 characters."),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      "confirm/edit only: your confidence in the promoted claim. " +
        "Defaults to the draft's own.",
    ),
});

export const definition = {
  name: "review_draft",
  description:
    "Review one of your own auto-captured draft claims (the SessionStart " +
    "briefing lists them): confirm it as your declared claim, edit its body " +
    "before confirming, or discard it. Reviewing is append-only — the draft " +
    "is superseded by a new claim, never rewritten — and works only on YOUR " +
    "drafts, never a teammate's.",
  inputSchema: z.toJSONSchema(ArgsSchema) as Record<string, unknown>,
};

const NOT_A_DRAFT =
  "That id is not among your unreviewed drafts on this repo. The SessionStart " +
  "briefing lists the reviewable ones; a draft already confirmed or discarded is " +
  "gone from that list, and a teammate's drafts are never reviewable by you.";

const EDIT_NEEDS_BODY =
  'action "edit" needs a body — the corrected assertion to publish in the ' +
  'draft\'s place. To keep the draft\'s own words use action "confirm".';

const SECRET_REFUSAL =
  "That body matches a secret pattern (key, token or credential), so it is " +
  "refused rather than uploaded — crosscheck never redacts, it drops. Reword " +
  "the claim without the credential material.";

const ECHO_REFUSAL_EDIT =
  "That text arrived in this session as a crosscheck hint — it is a teammate's " +
  "recorded claim, and rewriting your draft into their words would mint their " +
  "finding as yours (echo-loop exclusion). Build on their tree with " +
  "extend_diagnosis instead.";

interface Revision {
  readonly body: string;
  readonly status: string;
  readonly confidence: number;
  readonly provenance: string;
}

const buildRevision = (
  action: (typeof ACTIONS)[number],
  draft: DraftEntry,
  body: string | undefined,
  confidence: number | undefined,
): Revision => {
  if (action === "discard") {
    // Derived stays derived, so the hub's cap applies — clamp defensively.
    return {
      body: draft.body,
      status: "rejected",
      confidence: Math.min(draft.confidence, DERIVED_CONFIDENCE_CAP),
      provenance: "derived",
    };
  }
  return {
    body: action === "edit" ? (body ?? draft.body) : draft.body,
    status: draft.status,
    confidence: confidence ?? draft.confidence,
    provenance: "declared",
  };
};

/** Edit bodies are agent-supplied NEW text — the same gates as publishing. */
const editBodyRefusal = async (
  ctx: McpContext,
  own: OwnWorkContext,
  body: string,
): Promise<string | null> => {
  if (containsSecret(body)) {
    return SECRET_REFUSAL;
  }
  const state = await readSessionState(ctx.config.home, own.hostSessionKey);
  if (state !== null && isEchoOfDeliveredHint(body, state.deliveredHintHashes)) {
    return ECHO_REFUSAL_EDIT;
  }
  return null;
};

/**
 * Exported for the M14 class test, which drives it directly: the body class
 * of this echo has to be pinned beside the briefing line that prompts it, and
 * an end-to-end promote through a hub would prove the wiring rather than the
 * class.
 */
export const successText = (
  action: (typeof ACTIONS)[number],
  claimId: string,
  draftId: string,
  body: string,
): string => {
  if (action === "discard") {
    return (
      `Discarded draft ${safeId(draftId)}: a rejected revision ${claimId} now supersedes it. ` +
      "The draft stays in history but is no longer listed for review."
    );
  }
  const verb = action === "edit" ? "Promoted (edited)" : "Promoted";
  // The body is untrusted twice over — a derived draft's body came FROM the
  // hub, and an edit body is agent text — so it is framed and the sentence
  // that contains a frame travels under the notice that names it
  // (quotingText), like every framed tool answer. BODY class (`quotedBody`),
  // matching the briefing line this call answers: the agent is being told
  // WHICH assertion it just promoted, and an echo that blanks the assertion
  // whole answers a different question than the one it was asked.
  return quotingText(
    `${verb} draft ${safeId(draftId)} as your declared claim ${claimId} ` +
      `(a supersedes edge marks the draft reviewed): ${quotedBody(body, CLAIM_ECHO_MAX_CHARS)}. ` +
      "Pass this id as an evidenceRefs entry when you publish what supports it.",
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
  const { action, draft_claim_id: draftId, body, confidence } = parsed.value;
  if (action === "edit" && body === undefined) {
    return toolFailure(EDIT_NEEDS_BODY);
  }
  const own = await requireOwnContext(ctx);
  if (own === null) {
    return toolFailure(NO_SESSION);
  }

  // The hub's own-drafts list IS the authority on what is reviewable: it is
  // developer-scoped by the api key, so a teammate's draft or an already
  // reviewed one simply is not in it.
  const drafts = await getDrafts(ctx.hub, ctx.identity.repoId);
  if (!drafts.ok) {
    return hubFailure(ctx, drafts);
  }
  const draft = drafts.data.find((entry) => entry.id === draftId);
  if (draft === undefined) {
    return toolFailure(NOT_A_DRAFT);
  }

  if (action === "edit" && body !== undefined) {
    const refusal = await editBodyRefusal(ctx, own, body);
    if (refusal !== null) {
      return toolFailure(refusal);
    }
  }

  const revision = buildRevision(action, draft, body, confidence);
  const now = ctx.now().toISOString();
  const claim = {
    id: mintClaimId(),
    workContextId: draft.workContextId,
    authorSessionId: own.crosscheckSessionId,
    kind: draft.kind,
    body: revision.body,
    status: revision.status,
    confidence: revision.confidence,
    captureMode: "agent",
    provenance: revision.provenance,
    evidenceRefs: [],
    createdAt: now,
  };
  const rules = checkClaim(claim);
  if (!rules.ok) {
    return contractFailure(rules.messages);
  }
  const edge = {
    id: mintEdgeId(),
    fromClaimId: claim.id,
    toClaimId: draft.id,
    kind: "supersedes",
    authorSessionId: own.crosscheckSessionId,
    createdAt: now,
  };

  const producer = {
    sessionId: own.crosscheckSessionId,
    developerId: own.developerId,
  };
  // One batch, claim before edge: ingest processes records in order, so the
  // edge finds both endpoints (services/records.ts).
  const posted = await postRecords(ctx.hub, [
    envelopeFor(ctx, producer, "claim", claim),
    envelopeFor(ctx, producer, "claim_edge", edge),
  ]);
  if (!posted.ok) {
    return hubFailure(ctx, posted);
  }
  const claimOutcome = resultAt(posted.data.results, 0);
  if (claimOutcome?.status === "rejected") {
    return toolFailure(explainRejection(issuesOf(claimOutcome)));
  }
  if (claimOutcome?.status === "duplicate") {
    return toolFailure(
      "The hub already holds an identical revision of that draft — it was " +
        "probably reviewed moments ago in another session. Nothing was added.",
    );
  }
  const edgeOutcome = resultAt(posted.data.results, 1);
  if (edgeOutcome?.status === "rejected") {
    return toolFailure(
      `The revision was recorded as ${claim.id}, but the supersedes edge was refused, ` +
        `so the draft may still be listed:\n${explainRejection(issuesOf(edgeOutcome))}`,
    );
  }
  return toolText(successText(action, claim.id, draft.id, revision.body));
};
