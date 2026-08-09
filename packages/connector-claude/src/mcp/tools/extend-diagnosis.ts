/**
 * `extend_diagnosis` — a claim AND an edge, into somebody ELSE's tree.
 *
 * This is the move the whole product is for. "Your root cause is my symptom" is
 * not a comment on a ticket: it is a new claim, attached to the claim it goes
 * underneath, by an edge with a type. The hub allows a claim into a work context
 * owned by another developer for exactly this reason (services/record-handlers.ts
 * `ingestClaim` says so in as many words), and cross-author edges are by design.
 *
 * ORDER, AND WHY IT IS NOT THE OBVIOUS ONE. Two records go in one batch, claim
 * first, because the edge references the claim and the hub processes a batch
 * strictly in input order (services/records.ts). But the batch is only sent
 * after a READ of the target tree, and that read is not a courtesy — it is what
 * stops a half-write. Without it a wrong `targetClaimId` gets the claim accepted
 * and the edge refused, leaving an orphan claim in a stranger's tree that
 * nothing will ever attach or remove. The read costs one GET; the orphan costs
 * somebody else their diagnosis.
 *
 * The same read is what lets the `supersedes` rule be explained BEFORE anything
 * is written, instead of translated after the hub has refused it.
 */
import { z } from "zod";
import {
  ClaimKindSchema,
  ClaimStatusSchema,
  EdgeKindSchema,
} from "@crosscheck/schema";

import { toolFailure, toolText } from "../protocol.ts";
import type { ToolResult } from "../protocol.ts";
import type { McpContext } from "../context.ts";
import { checkClaim, checkClaimEdge, explainRejection } from "../violations.ts";
import { postRecords } from "../../http/hub.ts";
import type { Diagnosis } from "../../http/hub.ts";
import { fetchDiagnosis, isNotFound, notFoundText } from "./get-diagnosis.ts";
import {
  NO_SESSION,
  contractFailure,
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
import { MAX_ID_CHARS } from "../../constants.ts";
import { quoted, quotingText, safeId } from "../render.ts";

const DEFAULT_CONFIDENCE = 0.6;

export const ArgsSchema = z.object({
  workContextId: idArg(
    "work context",
    "The teammate's work context to extend. Get it from search_related_work.",
  ),
  targetClaimId: idArg(
    "claim",
    "The existing claim your new claim relates to. Get it from get_diagnosis " +
      "on that work context.",
  ),
  kind: ClaimKindSchema.describe("What kind of assertion YOUR new claim is."),
  body: z
    .string()
    .min(1)
    .describe("Your assertion, in one sentence. Max 400 characters."),
  edgeKind: EdgeKindSchema.default("deeper_cause_of").describe(
    "How your claim relates to theirs. deeper_cause_of: theirs is a symptom of " +
      "yours. contradicts: you think theirs is wrong. supports: yours backs " +
      "theirs. relates_to: connected but none of the above. supersedes is NOT " +
      "usable here — it means 'this replaces my own earlier claim' and works only " +
      "between two claims you wrote yourself.",
  ),
  status: ClaimStatusSchema.default("proposed").describe(
    "How settled your claim is. likely_root_cause requires an evidenceRefs entry.",
  ),
  confidence: z.number().min(0).max(1).default(DEFAULT_CONFIDENCE),
  evidenceRefs: z
    .array(z.string().min(1))
    .default([])
    .describe("Ids of claims that support yours — theirs count."),
  note: z
    .string()
    .default("")
    .describe("Optional one-line explanation of the link itself."),
});

export const definition = {
  name: "extend_diagnosis",
  description:
    "Add your claim to ANOTHER developer's diagnosis tree and link it to one of their " +
    "claims with a typed edge. This is how two investigations become one: if what they " +
    "called a root cause is a symptom of something you found, publish your finding here " +
    "with edgeKind deeper_cause_of and their tree gains the connection. Use contradicts " +
    "if you think a claim of theirs is wrong. Cross-author edges are intended, not a " +
    "workaround, and so are cross-repository ones: the work context may have been opened " +
    "from a different repository on this hub. Nothing is written unless both the work " +
    "context and the target claim exist, so a wrong id costs you a message rather than " +
    "leaving a stray claim in someone else's tree.",
  inputSchema: z.toJSONSchema(ArgsSchema) as Record<string, unknown>,
};

/**
 * `supersedes` explained before it is attempted.
 *
 * The hub enforces this rule (`ingestClaimEdge`), and it enforces it as a
 * `rejected` record inside a 200 — so echoing a status code would say nothing at
 * all. Saying it here has a second benefit the translation could not: the claim
 * is not written first, so the refusal leaves nothing behind.
 */
const SUPERSEDES_RULE =
  'supersedes means "this replaces my earlier claim" — it is revision, and it works ' +
  "only between two claims that are both your own. You are extending someone else's " +
  "tree, so it does not apply here. Use contradicts if you think their claim is " +
  "wrong, or deeper_cause_of if you think it is a symptom of something you found. " +
  "Both are cross-author by design. Nothing was written.";

/**
 * A claim that is really not in a tree that really is whole.
 *
 * The id is framed for the reason `notFoundText` gives at length: it is the
 * CALLER's argument, and a caller's argument is untrusted here. The work context
 * id beside it is bare, because that one DID resolve — the tree came back — so
 * the agent can use it again, which is exactly what the next sentence asks it
 * to do.
 */
export const targetClaimMissing = (
  workContextId: string,
  targetClaimId: string,
): string =>
  quotingText(
    `Work context ${safeId(workContextId)} has no claim ${quoted(targetClaimId, MAX_ID_CHARS)}, ` +
      "so there is nothing to link to and nothing was written.",
    "Call get_diagnosis on that work context and use a claim id it prints.",
  );

/**
 * The same absence, on a tree that did NOT come back whole — which is a
 * different fact and used to be reported as the same one.
 *
 * `truncated` and `droppedRows` were both in hand and both ignored, so the tool
 * asserted "has no claim X" about claims that exist and then sent the agent to
 * `get_diagnosis`, which reads the same endpoint under the same bounds and
 * returns the same partial tree. The agent reads it, does not find the claim,
 * calls extend_diagnosis again, and is told to call get_diagnosis again. That
 * advice is a loop with no exit, and the sentence that starts it is a statement
 * this connector cannot support.
 *
 * So this names the degradation instead of asserting non-existence, and offers
 * the two moves that are actually available: ask the human who owns the tree, or
 * record the finding where nothing can refuse it and link it later. Neither
 * loses the work.
 */
export const targetClaimUnverifiable = (
  workContextId: string,
  targetClaimId: string,
  diagnosis: Diagnosis,
): string => {
  const degradations = [
    ...(diagnosis.truncated
      ? ["the hub truncated it at its own bound"]
      : []),
    ...(diagnosis.droppedRows > 0
      ? [
          `${String(diagnosis.droppedRows)} of its rows could not be read by this connector and were dropped`,
        ]
      : []),
  ];
  return quotingText(
    `Work context ${safeId(workContextId)} came back INCOMPLETE — ${degradations.join(", and ")} — ` +
      `and claim ${quoted(targetClaimId, MAX_ID_CHARS)} is not in the part that arrived.`,
    "Nothing was written, because absence from a partial tree is not evidence that the " +
      "claim does not exist, and writing a claim whose edge would then be refused would " +
      "leave a stray claim in someone else's tree.",
    "Reading the tree again returns the same partial answer under the same bounds, so it " +
      "cannot settle this. Ask the work context's owner for the claim id, or record your " +
      "finding on your own work context with publish_claim and link it once you have an " +
      "id that resolves.",
  );
};

/**
 * Whether the target claim belongs to somebody else, as far as this machine can
 * tell.
 *
 * `null` means "cannot tell": an older hub sends no `authorDeveloperId`, and
 * this connector may hold no developer id of its own yet. The check is then
 * skipped and the hub stays the authority — which is why `explainRejection` also
 * carries the supersedes rule, as the backstop for exactly that case.
 */
const isForeignClaim = (
  diagnosis: Diagnosis,
  targetClaimId: string,
  ownDeveloperId: string | null,
): boolean | null => {
  const target = diagnosis.claims.find((claim) => claim.id === targetClaimId);
  if (
    target === undefined ||
    target.authorDeveloperId === undefined ||
    ownDeveloperId === null
  ) {
    return null;
  }
  return target.authorDeveloperId !== ownDeveloperId;
};

export const run = async (
  ctx: McpContext,
  args: unknown,
): Promise<ToolResult> => {
  const parsed = parseArgs(ArgsSchema, args, definition.name);
  if (!parsed.ok) {
    return parsed.result;
  }
  const { workContextId, targetClaimId } = parsed.value;

  const own = await requireOwnContext(ctx);
  if (own === null) {
    return toolFailure(NO_SESSION);
  }

  // Read before write — see the header. This validates the work context and the
  // target claim together, so neither can produce a half-written extension.
  const tree = await fetchDiagnosis(ctx, workContextId);
  if (!tree.ok) {
    return isNotFound(tree)
      ? toolFailure(notFoundText(workContextId))
      : hubFailure(ctx, tree);
  }
  if (!tree.data.claims.some((claim) => claim.id === targetClaimId)) {
    // A tree that arrived partial cannot answer "does this claim exist" at all,
    // and the two answers need different sentences — see the two builders above.
    const isPartial = tree.data.truncated || tree.data.droppedRows > 0;
    return toolFailure(
      isPartial
        ? targetClaimUnverifiable(workContextId, targetClaimId, tree.data)
        : targetClaimMissing(workContextId, targetClaimId),
    );
  }
  if (
    parsed.value.edgeKind === "supersedes" &&
    isForeignClaim(tree.data, targetClaimId, own.developerId) !== false
  ) {
    return toolFailure(SUPERSEDES_RULE);
  }

  const createdAt = ctx.now().toISOString();
  const claim = {
    id: mintClaimId(),
    // The claim goes into THEIR context — that is the whole point. The hub
    // permits it, and the author stays this session, so the tree shows two names.
    workContextId,
    authorSessionId: own.crosscheckSessionId,
    kind: parsed.value.kind,
    body: parsed.value.body,
    status: parsed.value.status,
    confidence: parsed.value.confidence,
    captureMode: "agent",
    provenance: "declared",
    evidenceRefs: parsed.value.evidenceRefs,
    createdAt,
  };
  const edge = {
    id: mintEdgeId(),
    // from: mine, to: theirs. `deeper_cause_of` then reads "my claim is a deeper
    // cause of theirs", which is the direction the product's sentence describes.
    fromClaimId: claim.id,
    toClaimId: targetClaimId,
    kind: parsed.value.edgeKind,
    authorSessionId: own.crosscheckSessionId,
    ...(parsed.value.note.length === 0 ? {} : { note: parsed.value.note }),
    createdAt,
  };

  const claimRules = checkClaim(claim);
  if (!claimRules.ok) {
    return contractFailure(claimRules.messages);
  }
  const edgeRules = checkClaimEdge(edge);
  if (!edgeRules.ok) {
    return contractFailure(edgeRules.messages);
  }

  const producer = {
    sessionId: own.crosscheckSessionId,
    developerId: own.developerId,
  };
  const posted = await postRecords(ctx.hub, [
    envelopeFor(ctx, producer, "claim", claim),
    envelopeFor(ctx, producer, "claim_edge", edge),
  ]);
  if (!posted.ok) {
    return hubFailure(ctx, posted);
  }

  const claimOutcome = resultAt(posted.data.results, 0);
  const edgeOutcome = resultAt(posted.data.results, 1);
  if (claimOutcome?.status === "rejected") {
    // `explainRejection` now frames what the hub said, so the notice that names
    // the frame has to travel with it.
    return toolFailure(
      quotingText(
        "The hub did not accept your claim, so no edge was created either.",
        explainRejection(issuesOf(claimOutcome)),
      ),
    );
  }
  // THE HUB CHOSE THIS ID, not this process. `results[].id` is whatever the
  // response said the claim landed as, and a controlled hub that answers with a
  // newline in it turns this one sentence into two. `safeId` is the same
  // allowlist the renderer prints every other id through, and it keeps the id
  // usable — which a frame would not.
  const landedClaimId = safeId(claimOutcome?.id ?? claim.id);
  if (edgeOutcome?.status === "rejected") {
    // Honest about the half that DID land: the claim is in their tree with no
    // edge on it, and whoever reads this needs to know that rather than assume
    // a clean failure.
    return toolFailure(
      quotingText(
        `Your claim was recorded as ${landedClaimId} on work context ${safeId(workContextId)}, but ` +
          `the ${edge.kind} edge to ${safeId(targetClaimId)} was refused, so the two are not ` +
          "linked yet.",
        explainRejection(issuesOf(edgeOutcome)),
      ),
    );
  }

  const already =
    claimOutcome?.status === "duplicate"
      ? " (your claim was already there, so it was not added twice)"
      : "";
  return toolText(
    `Extended work context ${safeId(workContextId)}: your ${claim.kind} ${landedClaimId} is now ` +
      `linked to ${safeId(targetClaimId)} by a ${edge.kind} edge${already}. Its author sees it the ` +
      "next time they read their own diagnosis.",
  );
};
