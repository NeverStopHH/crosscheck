/**
 * UserPromptSubmit — the injection pipeline's fast path (DESIGN.md §4).
 *
 * Inside the developer's keystroke: ONE bounded hub call (lexical candidates),
 * one bounded git call (drift), at most ONE hint, and silence on every doubt.
 * The 800 ms total budget is enforced by the runner's race
 * (USER_PROMPT_SUBMIT_BUDGET_RATIO), measured in test/hint-hook-latency.test.ts.
 *
 * ORDER AT THE END IS THE CONTRACT: telemetry spool append, then session
 * state (seen-set + echo hash), then emit. A crash between state write and
 * emit costs one hint slot — the honest direction; the reverse order could
 * deliver the same hint twice, which is the noise §10 risk 1 forbids.
 *
 * ASYNC SECOND CHANCE (§4's optional vector-tier redelivery) is a deliberate
 * deferral — reasoning at the header of packages/server/src/services/hints.ts,
 * which is the endpoint that would have to hold the pending state.
 */
import {
  HINT_MIN_TOKEN_CHARS,
  MAX_HINTS_PER_SESSION,
  MAX_SEARCH_QUERY_CHARS,
} from "../constants.ts";
import { hintDeliveryRecord, UNKNOWN_DEVELOPER_ID } from "../capture/records.ts";
import type { HintRefKind, Producer } from "../capture/records.ts";
import { resolveCommitDrift } from "../git/commit-drift.ts";
import type { CommitDrift } from "../git/commit-drift.ts";
import { getHintCandidates } from "../http/hub.ts";
import { hintBodyHash } from "../hints/echo.ts";
import { renderClaimHint, renderPointerHint } from "../hints/render.ts";
import { selectHint } from "../hints/select.ts";
import type { HintSelection } from "../hints/select.ts";
import { appendRecords } from "../spool/append.ts";
import {
  readSessionState,
  withDeliveredHint,
  writeSessionState,
} from "../state/session-state.ts";
import type { SessionState } from "../state/session-state.ts";
import type { HookContext } from "./runner.ts";

/** The same meaning floor the hub applies — zero HTTP for an empty question. */
const hasSearchableWord = (prompt: string): boolean =>
  prompt
    .split(/[^\p{L}\p{N}]+/u)
    .some((token) => token.length >= HINT_MIN_TOKEN_CHARS);

interface Delivery {
  readonly refKind: HintRefKind;
  readonly refId: string;
  readonly bodyHash: string | null;
  readonly text: string;
}

const renderSelection = async (
  ctx: HookContext,
  selection: HintSelection,
  now: Date,
): Promise<Delivery | null> => {
  if (selection.kind === "silence") {
    return null;
  }
  const context = selection.context.workContext;
  // Drift is a nice-to-have label: a slow or ignorant git loses it, never the
  // hint. Bounded by DRIFT_GIT_TIMEOUT_MS inside resolveCommitDrift.
  const drift: CommitDrift | null =
    context.baseCommit === undefined || context.baseCommit.length === 0
      ? null
      : await resolveCommitDrift(ctx.identity.root, context.baseCommit);
  if (selection.kind === "claim") {
    return {
      refKind: "claim",
      refId: selection.claim.id,
      bodyHash: hintBodyHash(selection.claim.body),
      text: renderClaimHint({ claim: selection.claim, context, drift, now }),
    };
  }
  return {
    refKind: "work_context",
    refId: context.id,
    bodyHash: null,
    text: renderPointerHint({
      context,
      claimCount: selection.claimCount,
      drift,
      now,
    }),
  };
};

const recordDelivery = async (
  ctx: HookContext,
  state: SessionState,
  delivery: Delivery,
  now: Date,
): Promise<void> => {
  const producer: Producer = {
    developerId: state.developerId ?? UNKNOWN_DEVELOPER_ID,
    agentKind: ctx.config.agentKind,
    sessionId: state.crosscheckSessionId,
  };
  // A local append, microseconds; the next hook's flush ships it, and a dead
  // hub leaves it spooled like any other record (idempotent by delivery id).
  await appendRecords(
    ctx.config.home,
    ctx.repoKey,
    ctx.payload.session_id,
    [
      hintDeliveryRecord(
        state.crosscheckSessionId,
        delivery.refKind,
        delivery.refId,
        producer,
        now,
      ),
    ],
    now,
  );
  await writeSessionState(
    ctx.config.home,
    withDeliveredHint(state, delivery.refId, delivery.bodyHash),
  );
};

export const handleUserPromptSubmit = async (
  ctx: HookContext,
): Promise<string> => {
  const prompt = ctx.payload.prompt ?? "";
  if (!hasSearchableWord(prompt)) {
    return "";
  }
  // No state file means SessionStart never ran here: no session to attribute
  // a delivery to and no seen-set to hold the cap — silence, not recovery.
  // (PostToolUse owns mid-session recovery; a hint is never worth a register.)
  const state = await readSessionState(ctx.config.home, ctx.payload.session_id);
  if (state === null) {
    return "";
  }
  if (state.deliveredHintRefs.length >= MAX_HINTS_PER_SESSION) {
    return "";
  }
  const result = await getHintCandidates(ctx.hub, {
    query: prompt.slice(0, MAX_SEARCH_QUERY_CHARS),
    repo: ctx.identity.repoId,
  });
  if (!result.ok) {
    return "";
  }
  const selection = selectHint({
    candidates: result.data,
    seenRefIds: state.deliveredHintRefs,
    deliveredCount: state.deliveredHintRefs.length,
    selfDeveloperId: state.developerId,
  });
  const now = ctx.now();
  const delivery = await renderSelection(ctx, selection, now);
  if (delivery === null || delivery.text.length === 0) {
    return "";
  }
  await recordDelivery(ctx, state, delivery, now);
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: delivery.text,
    },
  });
};
